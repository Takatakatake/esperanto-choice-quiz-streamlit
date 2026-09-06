import uuid

from score_sync_service import (
    append_score_record,
    update_totals_for_record,
)
from score_row_utils import SENTENCE_MODE, VOCAB_MODE, normalize_mode, normalize_score_row
from user_settings import normalize_user


def _safe_float(value, default=0.0):
    try:
        if value is None:
            return default
        if isinstance(value, str) and not value.strip():
            return default
        parsed = float(value)
        if parsed != parsed or parsed in (float("inf"), float("-inf")):
            return default
        return parsed
    except (TypeError, ValueError):
        return default


def _safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ユーザー可視メッセージの3言語表（PWAは payload.targetLang を送ってくる。
# 旧クライアント・不正値は ja にフォールバック）。モジュール内で完結させ、
# 新たなクロスモジュール import を増やさない（Streamlit Cloud の
# stale-module-cache 由来 ImportError を避ける設計）。
_MESSAGES = {
    "bad_request": {
        "ja": "保存要求の形式が不正です。",
        "zh": "保存请求的格式不正确。",
        "ko": "저장 요청 형식이 올바르지 않습니다.",
    },
    "need_user": {
        "ja": "保存するには有効なユーザー名が必要です。",
        "zh": "保存分数需要先输入有效的用户名。",
        "ko": "저장하려면 올바른 사용자 이름이 필요합니다.",
    },
    "no_result": {
        "ja": "保存できるクイズ結果がありません。",
        "zh": "没有可保存的测验结果。",
        "ko": "저장할 수 있는 퀴즈 결과가 없습니다.",
    },
    "sheets_failed": {
        "ja": "Google Sheetsへの保存に失敗しました。Secrets設定とSheets共有権限を確認してください。",
        "zh": "保存到 Google Sheets 失败。请检查 Secrets 配置和表格的共享权限。",
        "ko": "Google Sheets 저장에 실패했습니다. Secrets 설정과 시트 공유 권한을 확인해 주세요.",
    },
    "totals_failed": {
        "ja": "スコアログは保存済みです。累積得点の更新だけ失敗したため、もう一度押すと同じ保存IDで安全に再更新します。",
        "zh": "分数日志已保存，但累计得分更新失败。再按一次会使用相同的保存ID安全地重新更新。",
        "ko": "점수 로그는 저장되었습니다. 누적 점수 업데이트만 실패했으므로 다시 누르면 같은 저장 ID로 안전하게 다시 업데이트됩니다.",
    },
    "saved": {
        "ja": "学習記録を保存しました。今回の{points:.1f}点を累積得点に加算済みです。",
        "zh": "已保存学习记录。本次 {points:.1f} 分已计入累计得分。",
        "ko": "학습 기록을 저장했습니다. 이번에 얻은 {points:.1f}점은 누적 점수에 반영되었습니다.",
    },
}


def _payload_lang(payload):
    if not isinstance(payload, dict):
        return "ja"
    lang = str(payload.get("targetLang") or "ja").strip().lower()[:2]
    return lang if lang in ("ja", "zh", "ko") else "ja"


def _msg(payload, key, **fmt):
    table = _MESSAGES[key]
    text = table.get(_payload_lang(payload), table["ja"])
    return text.format(**fmt) if fmt else text


def _score_result(payload, *, ok, message, warning=None, recoverable=""):
    return {
        "type": "score_save_result",
        "requestId": str(payload.get("requestId", "")),
        "saveId": str(payload.get("saveId", "")),
        "ok": bool(ok),
        "message": message,
        "warning": warning or "",
        "recoverable": recoverable or "",
    }


def _build_record(payload):
    mode = normalize_mode(payload.get("mode"), fallback=VOCAB_MODE)
    save_id = str(payload.get("saveId") or "").strip() or f"mobile-{uuid.uuid4()}"
    user = normalize_user(payload.get("user"))
    levels = payload.get("levels")
    if isinstance(levels, (list, tuple)):
        levels = ",".join(str(level) for level in levels)
    else:
        levels = str(levels or "")

    common = {
        "user": user,
        "mode": mode,
        "correct": _safe_int(payload.get("correct"), 0),
        "total": _safe_int(payload.get("total"), 0),
        "accuracy": _safe_float(payload.get("accuracy"), 0.0),
        "points": _safe_float(payload.get("points"), 0.0),
        "spartan_attempts": _safe_int(payload.get("spartanAttempts"), 0),
        "spartan_correct": _safe_int(payload.get("spartanCorrect"), 0),
        "spartan_accuracy": _safe_float(payload.get("spartanAccuracy"), 0.0),
        "spartan_mode": bool(payload.get("spartanMode")),
        "direction": str(payload.get("direction") or ""),
        "accuracy_bonus": _safe_float(payload.get("accuracyBonus"), 0.0),
        "accuracy_bonus_spartan": 0.0,
        "source": "mobile_app",
        "mobile_session_id": str(payload.get("sessionId") or ""),
        "mobile_app_version": str(payload.get("appVersion") or ""),
        "started_at": str(payload.get("startedAt") or ""),
        "completed_at": str(payload.get("completedAt") or ""),
        "ts": str(payload.get("ts") or ""),
        "save_id": save_id,
    }

    if mode == SENTENCE_MODE:
        return normalize_score_row(
            {
                **common,
                "topic": str(payload.get("topic") or ""),
                "subtopic": str(payload.get("subtopic") or ""),
                "levels": levels,
                "raw_points": _safe_float(payload.get("rawPointsMain"), 0.0)
                + _safe_float(payload.get("spartanScaledPoints"), 0.0),
                "points_main": _safe_float(payload.get("rawPointsMain"), 0.0),
                "points_spartan_raw": _safe_float(payload.get("rawPointsSpartan"), 0.0),
                "points_spartan_scaled": _safe_float(payload.get("spartanScaledPoints"), 0.0),
            },
            fallback_mode=SENTENCE_MODE,
        )

    return normalize_score_row(
        {
            **common,
            "group_id": str(payload.get("groupId") or ""),
            "seed": _safe_int(payload.get("seed"), 1),
            "pos": str(payload.get("pos") or ""),
            "raw_points_total": _safe_float(payload.get("rawPointsTotal"), 0.0),
            "raw_points_main": _safe_float(payload.get("rawPointsMain"), 0.0),
            "raw_points_spartan": _safe_float(payload.get("rawPointsSpartan"), 0.0),
            "accuracy_bonus_main": _safe_float(payload.get("accuracyBonus"), 0.0),
            "spartan_scaled_points": _safe_float(payload.get("spartanScaledPoints"), 0.0),
        },
        fallback_mode=VOCAB_MODE,
    )


def _append_score(record):
    return append_score_record(record, fallback_mode=record.get("mode") or VOCAB_MODE)


def _update_totals(record):
    return update_totals_for_record(record)


def save_mobile_score_request(payload):
    if not isinstance(payload, dict) or payload.get("type") != "save_score":
        return _score_result({}, ok=False, message=_msg(payload, "bad_request"))

    user = normalize_user(payload.get("user"))
    if not user:
        return _score_result(payload, ok=False, message=_msg(payload, "need_user"))

    record = _build_record(payload)
    if record["total"] <= 0:
        return _score_result(payload, ok=False, message=_msg(payload, "no_result"))

    if not _append_score(record):
        return _score_result(
            payload,
            ok=False,
            message=_msg(payload, "sheets_failed"),
        )

    overall_ok, sentence_ok = _update_totals(record)
    if not overall_ok or not sentence_ok:
        return _score_result(
            payload,
            ok=False,
            message=_msg(payload, "totals_failed"),
            recoverable="totals_update",
        )

    points = _safe_float(record.get("points"), 0.0)
    return _score_result(
        payload,
        ok=True,
        message=_msg(payload, "saved", points=points),
    )
