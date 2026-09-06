import datetime

try:
    import pandas as pd
except Exception:  # pragma: no cover - pandas is available in the app, but keep this helper portable.
    pd = None

from score_row_utils import iter_unique_score_rows


HOF_THRESHOLD = 1_000_000
RANKING_TOP_N = 20


def safe_float(value, default=0.0):
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


def parse_jst_date(value):
    raw = str(value or "").strip()
    if not raw:
        return None
    jst = datetime.timezone(datetime.timedelta(hours=9))

    if pd is not None:
        parsed_ts = pd.to_datetime(raw, errors="coerce", utc=True)
        if pd.notna(parsed_ts):
            return parsed_ts.tz_convert(jst).date()

    normalized = raw.replace("Z", "+00:00")
    try:
        parsed = datetime.datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.astimezone(jst).date()


def score_log_totals(score_rows, *, now=None):
    jst = datetime.timezone(datetime.timedelta(hours=9))
    today = (now or datetime.datetime.now(jst)).astimezone(jst).date()
    month_start = today.replace(day=1)
    next_month_start = (month_start + datetime.timedelta(days=32)).replace(day=1)
    overall = {}
    today_totals = {}
    month_totals = {}

    for row in iter_unique_score_rows(score_rows or []):
        user = str(row.get("user") or "").strip()
        if not user:
            continue
        points = safe_float(row.get("points"), 0.0)
        overall[user] = overall.get(user, 0.0) + points

        score_date = parse_jst_date(row.get("ts") or row.get("completed_at"))
        if not score_date:
            continue
        if score_date == today:
            today_totals[user] = today_totals.get(user, 0.0) + points
        if month_start <= score_date < next_month_start:
            month_totals[user] = month_totals.get(user, 0.0) + points

    return overall, today_totals, month_totals


def stats_totals(stats_rows):
    totals = {}
    for row in stats_rows or []:
        user = str(row.get("user") or "").strip()
        if not user:
            continue
        total = row.get("total_points")
        if total is None:
            for key, value in row.items():
                if "total_points" in str(key):
                    total = value
                    break
        totals[user] = max(totals.get(user, 0.0), safe_float(total, 0.0))
    return totals


def merge_max(primary, secondary):
    merged = dict(primary or {})
    for user, points in (secondary or {}).items():
        merged[user] = max(safe_float(merged.get(user), 0.0), safe_float(points, 0.0))
    return merged


def summarize_rankings_from_stats(stats_rows, *, score_rows=None, hof_threshold=HOF_THRESHOLD):
    is_raw_log = False
    if stats_rows and isinstance(stats_rows, list):
        first_row = stats_rows[0] if stats_rows else {}
        is_raw_log = "total_points" not in first_row and "points" in first_row

    if is_raw_log:
        totals, _, _ = score_log_totals(stats_rows)
    else:
        totals = stats_totals(stats_rows)

    score_totals, today_totals, month_totals = score_log_totals(score_rows or [])
    # A first new score is not evidence that all legacy logs are present.
    # Preserve existing totals until a separate verified reconciliation is done.
    totals = merge_max(totals, score_totals) if totals else score_totals
    hof = {user: points for user, points in totals.items() if points >= hof_threshold}
    return totals, today_totals, month_totals, hof


def rank_dict(totals, top_n=None):
    items = sorted(
        ((user, safe_float(points, 0.0)) for user, points in (totals or {}).items()),
        key=lambda item: (-item[1], str(item[0]).lower()),
    )
    return items[:top_n] if top_n else items


def ranking_rows(totals, *, current_user="", top_n=RANKING_TOP_N):
    ranked = rank_dict(totals)
    rows = []
    current = None
    normalized_current = str(current_user or "").strip()
    for index, (user, points) in enumerate(ranked, start=1):
        if not str(user).strip():
            continue
        row = {
            "rank": index,
            "user": user,
            "points": round(points, 1),
            "isCurrentUser": bool(normalized_current and user == normalized_current),
        }
        if index <= top_n:
            rows.append(row)
        if row["isCurrentUser"]:
            current = row
    if current and not any(row["user"] == current["user"] for row in rows):
        rows.append(current)
    return rows, current
