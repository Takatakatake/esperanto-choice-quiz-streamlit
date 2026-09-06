"""Name-based ranking preferences, stored separately from derived score totals."""

import datetime
import logging
import time

from gspread.utils import rowcol_to_a1

import score_append_utils as sheet_store


USER_SETTINGS_SHEET = "UserSettings"
REQUIRED_HEADERS = ("user", "ranking_public", "updated_at")
_LOGGER = logging.getLogger(__name__)

_MESSAGES = {
    "bad_request": {
        "ja": "公開設定の要求形式が不正です。",
        "zh": "公开设置请求的格式不正确。",
        "ko": "공개 설정 요청 형식이 올바르지 않습니다.",
    },
    "need_user": {
        "ja": "有効なユーザー名を入力してください。",
        "zh": "请输入有效的用户名。",
        "ko": "올바른 사용자 이름을 입력해 주세요.",
    },
    "fetch_failed": {
        "ja": "ランキングの公開設定を確認できませんでした。時間をおいて再読み込みしてください。",
        "zh": "无法确认排行榜公开设置。请稍后重新加载。",
        "ko": "랭킹 공개 설정을 확인하지 못했습니다. 잠시 후 다시 불러와 주세요.",
    },
    "save_failed": {
        "ja": "公開設定の保存を確認できませんでした。再読み込みして設定を確認してください。",
        "zh": "无法确认公开设置是否已保存。请重新加载并确认设置。",
        "ko": "공개 설정이 저장되었는지 확인하지 못했습니다. 다시 불러와 설정을 확인해 주세요.",
    },
    "saved": {
        "ja": "ランキングの公開設定を保存しました。",
        "zh": "已保存排行榜公开设置。",
        "ko": "랭킹 공개 설정을 저장했습니다.",
    },
}


def request_message(payload, messages, key):
    lang = str(payload.get("targetLang") or "ja").strip().lower()[:2] if isinstance(payload, dict) else "ja"
    table = messages[key]
    return table.get(lang, table["ja"])


def normalize_user(value):
    """Keep established, case-sensitive names; only trim surrounding whitespace."""
    if not isinstance(value, str):
        return ""
    user = value.strip()
    if any(ord(char) < 32 or ord(char) == 127 for char in user):
        return ""
    return user


class SettingsUnavailable(ValueError):
    """A preference read is unavailable or cannot safely establish visibility."""


def _parse_visibility(value):
    if isinstance(value, bool):
        return value
    # Sheets stores RAW values as strings, or TRUE/FALSE when edited by hand.
    normalized = str(value).strip().lower()
    if normalized in ("true", "1"):
        return True
    if normalized in ("false", "0"):
        return False
    raise SettingsUnavailable("Invalid ranking visibility")


def _validated_sheet(values):
    if not values:
        raise SettingsUnavailable("UserSettings headers are missing")
    headers = [str(value).strip() for value in values[0]]
    if any(headers.count(key) != 1 for key in REQUIRED_HEADERS):
        raise SettingsUnavailable("UserSettings headers are invalid")

    user_idx = headers.index("user")
    public_idx = headers.index("ranking_public")
    settings = {}
    for raw_row in values[1:]:
        if not any(str(value).strip() for value in raw_row):
            continue
        row = list(raw_row) + [""] * max(0, len(headers) - len(raw_row))
        user = normalize_user(row[user_idx])
        if not user:
            raise SettingsUnavailable("UserSettings contains an invalid user")
        ranking_public = _parse_visibility(row[public_idx])
        # Concurrent first saves can leave duplicate rows. Any private row wins
        # until an explicit successful save updates all rows for this name.
        settings[user] = settings.get(user, True) and ranking_public
    return headers, settings


def _read_settings_sheet():
    ws, cache_key = sheet_store._open_worksheet(USER_SETTINGS_SHEET, refresh=True)
    if ws is None:
        raise SettingsUnavailable("UserSettings is unavailable")
    try:
        values = sheet_store._read_sheet_values(ws)
        headers, settings = _validated_sheet(values)
    except Exception:
        sheet_store._invalidate_cache(cache_key)
        raise
    return ws, cache_key, values, headers, settings


def load_ranking_visibility():
    """Return validated preferences, or None: callers must not publish on failure."""
    try:
        return _read_settings_sheet()[4]
    except Exception as exc:
        # Log the failure class only: API exceptions may contain credentials/URLs.
        _LOGGER.warning("UserSettings read failed (%s)", type(exc).__name__)
        return None


def user_settings_result(user, visibility, payload):
    if visibility is None:
        return {
            "ok": False,
            "rankingPublic": False,
            "message": request_message(payload, _MESSAGES, "fetch_failed"),
        }
    return {"ok": True, "rankingPublic": visibility.get(user, True), "message": ""}


def upsert_user_settings(user, ranking_public, *, retries=3, retry_base_sec=0.2):
    """Read before each attempt, change preference cells only, then verify."""
    if not normalize_user(user) or not isinstance(ranking_public, bool):
        return False
    user = normalize_user(user)
    attempts = max(1, retries)
    for attempt in range(attempts):
        cache_key = None
        try:
            ws, cache_key, values, headers, _ = _read_settings_sheet()
            user_idx = headers.index("user")
            public_idx = headers.index("ranking_public")
            updated_idx = headers.index("updated_at")
            updated_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
            public_value = "true" if ranking_public else "false"
            matching_rows = [
                row_number
                for row_number, row in enumerate(values[1:], start=2)
                if user_idx < len(row) and normalize_user(row[user_idx]) == user
            ]
            if matching_rows:
                updates = []
                for row_number in matching_rows:
                    for index, value in ((public_idx, public_value), (updated_idx, updated_at)):
                        updates.append({"range": rowcol_to_a1(row_number, index + 1), "values": [[value]]})
                ws.batch_update(updates, value_input_option="RAW")
            else:
                record = {"user": user, "ranking_public": public_value, "updated_at": updated_at}
                ws.append_row(sheet_store._row_from_headers(record, headers), value_input_option="RAW")

            verified = _read_settings_sheet()[4]
            if user in verified and verified[user] is ranking_public:
                return True
            # A different confirmed value can be a newer concurrent choice.
            # Report the conflict instead of retrying and overwriting that choice.
            _LOGGER.warning("UserSettings verification did not match")
            return False
        except Exception as exc:
            sheet_store._invalidate_cache(cache_key)
            _LOGGER.warning("UserSettings save attempt failed (%s)", type(exc).__name__)
        if attempt + 1 < attempts:
            time.sleep(retry_base_sec * (2 ** attempt))
    return False


def save_user_settings_request(payload):
    valid_payload = isinstance(payload, dict) and payload.get("type") == "save_user_settings"
    request = payload if isinstance(payload, dict) else {}
    user = normalize_user(request.get("user"))
    result = {
        "type": "user_settings_result",
        "requestId": str(request.get("requestId", "")),
        "user": user,
        "ok": False,
        "rankingPublic": False,
        "message": "",
        "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    if not valid_payload or not isinstance(request.get("rankingPublic"), bool):
        result["message"] = request_message(payload, _MESSAGES, "bad_request")
    elif not user:
        result["message"] = request_message(payload, _MESSAGES, "need_user")
    elif not upsert_user_settings(user, request["rankingPublic"]):
        result["message"] = request_message(payload, _MESSAGES, "save_failed")
    else:
        result.update(ok=True, rankingPublic=request["rankingPublic"], message=request_message(payload, _MESSAGES, "saved"))
    return result
