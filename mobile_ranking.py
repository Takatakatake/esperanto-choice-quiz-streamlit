import datetime

from score_append_utils import load_sheet_records
from ranking_utils import HOF_THRESHOLD, RANKING_TOP_N, ranking_rows, summarize_rankings_from_stats
from user_settings import load_ranking_visibility, normalize_user


SCORES_SHEET = "Scores"
USER_STATS_SHEET = "UserStats"



# ユーザー可視メッセージの3言語表（payload.targetLang により選択・ja フォールバック）。
_MESSAGES = {
    "bad_request": {
        "ja": "ランキング取得要求の形式が不正です。",
        "zh": "排行榜请求的格式不正确。",
        "ko": "랭킹 요청 형식이 올바르지 않습니다.",
    },
    "fetch_failed": {
        "ja": "ランキングを取得できませんでした。時間をおいて再読み込みしてください。",
        "zh": "无法获取排行榜。请稍后重新加载。",
        "ko": "랭킹을 가져오지 못했습니다. 잠시 후 다시 불러와 주세요.",
    },
    "settings_failed": {
        "ja": "公開設定を確認できないためランキングを表示できません。時間をおいて再読み込みしてください。",
        "zh": "无法确认公开设置，因此暂时不能显示排行榜。请稍后重新加载。",
        "ko": "공개 설정을 확인하지 못해 랭킹을 표시할 수 없습니다. 잠시 후 다시 불러와 주세요.",
    },
    "shown": {
        "ja": "ランキングを表示しました。",
        "zh": "已显示排行榜。",
        "ko": "랭킹을 표시했습니다.",
    },
    "scores_only": {
        "ja": "ランキングを表示しました。累積は保存ログから再集計しています。",
        "zh": "已显示排行榜。累计得分正根据保存日志重新统计。",
        "ko": "랭킹을 표시했습니다. 누적 점수는 저장 로그에서 다시 집계한 값입니다.",
    },
    "stats_only": {
        "ja": "累積ランキングを表示しました。本日・今月は保存ログを確認できないため未表示です。",
        "zh": "已显示累计排行榜。由于无法读取保存日志，今日和本月排行暂不显示。",
        "ko": "누적 랭킹을 표시했습니다. 저장 로그를 확인할 수 없어 오늘/이번 달 랭킹은 표시되지 않습니다.",
    },
}


def _payload_lang(payload):
    if not isinstance(payload, dict):
        return "ja"
    lang = str(payload.get("targetLang") or "ja").strip().lower()[:2]
    return lang if lang in ("ja", "zh", "ko") else "ja"


def _msg(payload, key):
    table = _MESSAGES[key]
    return table.get(_payload_lang(payload), table["ja"])


def _ranking_result(payload, *, ok, message, rankings=None, own=None, source="unavailable"):
    return {
        "type": "rankings_result",
        "requestId": str(payload.get("requestId", "")),
        "user": normalize_user(payload.get("user")),
        "ok": bool(ok),
        "message": message,
        "source": source,
        "rankings": rankings or {"overall": [], "today": [], "month": [], "hof": []},
        "own": own or {},
        "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


def load_mobile_rankings_request(payload):
    if not isinstance(payload, dict) or payload.get("type") != "load_rankings":
        return _ranking_result({}, ok=False, message=_msg(payload, "bad_request"))

    user = normalize_user(payload.get("user"))
    visibility = load_ranking_visibility()
    if visibility is None:
        return _ranking_result(payload, ok=False, message=_msg(payload, "settings_failed"))

    stats_rows = load_sheet_records(USER_STATS_SHEET, refresh=True)
    score_rows = load_sheet_records(SCORES_SHEET, refresh=True)

    if stats_rows is None and score_rows is None:
        return _ranking_result(
            payload,
            ok=False,
            message=_msg(payload, "fetch_failed"),
        )

    overall_totals, today_totals, month_totals, hof_totals = summarize_rankings_from_stats(
        stats_rows or [],
        score_rows=score_rows or [],
        hof_threshold=HOF_THRESHOLD,
    )

    # Filter before ranking so private accounts neither appear in any list nor
    # consume a rank. This also excludes the current user's appended own row.
    overall_totals, today_totals, month_totals, hof_totals = (
        {name: points for name, points in totals.items() if visibility.get(name, True)}
        for totals in (overall_totals, today_totals, month_totals, hof_totals)
    )

    overall_rows, own_overall = ranking_rows(overall_totals, current_user=user, top_n=RANKING_TOP_N)
    today_rows, own_today = ranking_rows(today_totals, current_user=user, top_n=RANKING_TOP_N)
    month_rows, own_month = ranking_rows(month_totals, current_user=user, top_n=RANKING_TOP_N)
    hof_rows, own_hof = ranking_rows(hof_totals, current_user=user, top_n=RANKING_TOP_N)

    source = "live"
    warning = ""
    if stats_rows is None:
        source = "scores_only"
        warning = _msg(payload, "scores_only")
    elif score_rows is None:
        source = "stats_only"
        warning = _msg(payload, "stats_only")

    return _ranking_result(
        payload,
        ok=True,
        message=warning or _msg(payload, "shown"),
        source=source,
        rankings={
            "overall": overall_rows,
            "today": today_rows,
            "month": month_rows,
            "hof": hof_rows,
        },
        own={
            "overall": own_overall,
            "today": own_today,
            "month": own_month,
            "hof": own_hof,
        },
    )
