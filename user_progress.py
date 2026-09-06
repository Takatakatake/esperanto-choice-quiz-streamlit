"""Aggregate all saved learning records by name, independently of public ranking."""

import datetime
import re

from ranking_utils import safe_float
from score_append_utils import load_sheet_records
from score_row_utils import SENTENCE_MODE, VOCAB_MODE, infer_mode, iter_unique_score_rows
from user_settings import load_ranking_visibility, normalize_user, request_message, request_user_identity, user_settings_result


_MESSAGES = {
    "bad_request": {
        "ja": "学習記録の取得要求の形式が不正です。",
        "zh": "学习记录请求的格式不正确。",
        "ko": "학습 기록 요청 형식이 올바르지 않습니다.",
    },
    "need_user": {
        "ja": "学習記録を見るには有効なユーザー名を入力してください。",
        "zh": "请输入有效的用户名以查看学习记录。",
        "ko": "학습 기록을 보려면 올바른 사용자 이름을 입력해 주세요.",
    },
    "fetch_failed": {
        "ja": "学習記録を取得できませんでした。時間をおいて再読み込みしてください。",
        "zh": "无法获取学习记录。请稍后重新加载。",
        "ko": "학습 기록을 가져오지 못했습니다. 잠시 후 다시 불러와 주세요.",
    },
    "shown": {
        "ja": "保存済みの学習記録を表示しました。",
        "zh": "已显示保存的学习记录。",
        "ko": "저장된 학습 기록을 표시했습니다.",
    },
}

_VOCAB_LEVELS = ("beginner", "intermediate", "advanced")
_VOCAB_GROUP_ID = re.compile(r"([^:\s]+):([^:\s]+):g[1-9][0-9]*")
_VOCAB_STAGE = re.compile(r"(?:beginner(?:_[1-3])?|intermediate(?:_[1-3])?|advanced(?:_[1-6])?)")


def _category_key(value):
    return str(value or "").strip() or "unknown"


def _vocab_category(row):
    pos = str(row.get("pos") or "").strip()
    if pos:
        return pos
    group_id = str(row.get("group_id") or "").strip()
    return _category_key(group_id.split(":", 1)[0]) if ":" in group_id else "unknown"


def _vocab_level(row):
    """Recover a quiz's saved difficulty without reallocating mixed-group points."""
    match = _VOCAB_GROUP_ID.fullmatch(str(row.get("group_id") or "").strip())
    if not match or match[1] != _vocab_category(row):
        return "unknown"
    stages = match[2].split("+")
    if not all(_VOCAB_STAGE.fullmatch(stage) for stage in stages):
        return "unknown"
    levels = {stage.split("_", 1)[0] for stage in stages}
    # Scores are saved per quiz, so a group spanning levels must stay together.
    return "+".join(level for level in _VOCAB_LEVELS if level in levels)


def _sorted_vocab_levels(categories):
    levels = [categories.get(key, {"key": key, "points": 0.0, "attempts": 0}) for key in _VOCAB_LEVELS]
    mixed_keys = sorted(
        (key for key in categories if key not in (*_VOCAB_LEVELS, "unknown")),
        key=lambda key: tuple(_VOCAB_LEVELS.index(level) for level in key.split("+")),
    )
    levels.extend(categories[key] for key in mixed_keys)
    if "unknown" in categories:
        levels.append(categories["unknown"])
    return levels


def _add_category(categories, key, points):
    category = categories.setdefault(key, {"key": key, "points": 0.0, "attempts": 0})
    category["points"] += points
    category["attempts"] += 1
    return category


def _sorted_categories(categories):
    return sorted(categories.values(), key=lambda row: (-row["points"], row["key"]))


def compute_user_progress(records, user):
    """Count unique saved quizzes; legacy rows without save_id each count once."""
    user = normalize_user(user)
    totals = {"overall": 0.0, "vocab": 0.0, "sentence": 0.0}
    vocab = {}
    vocab_levels = {}
    sentence = {}
    subtopics = {}
    if user:
        for row in iter_unique_score_rows(records):
            if normalize_user(row.get("user")) != user:
                continue
            points = safe_float(row.get("points"), 0.0)
            mode = infer_mode(row, fallback=VOCAB_MODE)
            totals["overall"] += points
            totals[mode] += points
            if mode == SENTENCE_MODE:
                topic = _category_key(row.get("topic"))
                _add_category(sentence, topic, points)
                _add_category(subtopics.setdefault(topic, {}), _category_key(row.get("subtopic")), points)
            else:
                pos = _vocab_category(row)
                _add_category(vocab, pos, points)
                _add_category(vocab_levels.setdefault(pos, {}), _vocab_level(row), points)
    for pos, category in vocab.items():
        category["levels"] = _sorted_vocab_levels(vocab_levels[pos])
    for topic, category in sentence.items():
        category["subtopics"] = _sorted_categories(subtopics[topic])
    return {"totals": totals, "categories": {"vocab": _sorted_categories(vocab), "sentence": _sorted_categories(sentence)}}


def load_user_progress_request(payload):
    valid_payload = isinstance(payload, dict) and payload.get("type") == "load_progress"
    request = payload if isinstance(payload, dict) else {}
    user = normalize_user(request.get("user"))
    result = {
        "type": "progress_result",
        "requestId": str(request.get("requestId", "")),
        "user": request_user_identity(request.get("user")),
        "ok": False,
        "message": "",
        "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        # A failed read must not masquerade as an empty account or replace totals.
        "totals": None,
        "categories": {"vocab": [], "sentence": []},
        "settings": user_settings_result(user, None, payload),
    }
    if not valid_payload:
        result["message"] = request_message(payload, _MESSAGES, "bad_request")
        return result
    if not user:
        result["message"] = request_message(payload, _MESSAGES, "need_user")
        return result

    rows = load_sheet_records("Scores", refresh=True, required_headers=("user", "points"))
    visibility = load_ranking_visibility()
    result["settings"] = user_settings_result(user, visibility, payload)
    if rows is None:
        result["message"] = request_message(payload, _MESSAGES, "fetch_failed")
        return result
    result.update(compute_user_progress(rows, user))
    result.update(ok=True, message=request_message(payload, _MESSAGES, "shown"))
    return result
