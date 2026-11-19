"""Output guardrails for provenance, prompt injection, and safe errors."""
from __future__ import annotations

import datetime as dt
import json
import re
from typing import Any, Iterable

_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
_DATE_RE = re.compile(r"\b(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\b")
_MONTH_DATE_RE = re.compile(
    r"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?\b",
    re.I,
)
_DAY_MONTH_DATE_RE = re.compile(
    r"\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b",
    re.I,
)
_NUMBER_RE = re.compile(r"(?<![A-Za-z])[-+]?\d+(?:[.,]\d+)?%?(?![A-Za-z])")
_FORBIDDEN_REPLY_RE = re.compile(
    r"(?:api\s*key|secret\s+key|system\s+prompt|reveal\s+(?:the\s+)?prompt|"
    r"ignore\s+(?:all\s+)?(?:previous|your)\s+rules|guarantee(?:d)?\s+mission|"
    r"mission\s+success\s+guarantee|\b(?:site\s+is\s+)?(?:un)?safe\b|"
    r"مفتاح|برومبت|التعليمات|اتجاهل|تجاهل|آمن|آمنة|نجاح\s+المهمة|القواعد)",
    re.I,
)
_DIRECTION_WORDS = (
    "north",
    "south",
    "east",
    "west",
    "northeast",
    "northwest",
    "southeast",
    "southwest",
    "شمال",
    "جنوب",
    "شرق",
    "غرب",
)
_SITE_NOUNS = ("site", "rim", "massif", "ridge", "plateau", "موقع")


def normalize_digits(value: str) -> str:
    return value.translate(_ARABIC_DIGITS).replace("٫", ".").replace("٬", ",")


def _date_key(value: str) -> str | None:
    value = normalize_digits(value).strip().replace("/", "-")
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%m-%d-%Y"):
        try:
            return dt.datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue
    try:
        dt.date.fromisoformat(value[:10])
        return value[:10]
    except ValueError:
        pass
    for fmt in ("%b %d %Y", "%B %d %Y", "%b %d", "%B %d", "%d %b %Y", "%d %B %Y"):
        try:
            parsed = dt.datetime.strptime(value.replace(",", ""), fmt)
            return parsed.date().isoformat() if "%Y" in fmt else parsed.strftime("%m-%d")
        except ValueError:
            continue
    return None


def _date_patterns() -> tuple[re.Pattern[str], ...]:
    return (_DATE_RE, _MONTH_DATE_RE, _DAY_MONTH_DATE_RE)


def _numeric_values(text: str) -> list[float]:
    text = normalize_digits(text)
    # Remove complete dates before extracting numbers. This prevents accepting
    # or comparing an ISO date one component at a time.
    for regex in _date_patterns():
        text = regex.sub(" ", text)
    values: list[float] = []
    for match in _NUMBER_RE.finditer(text):
        token = match.group(0).rstrip("%").replace(",", "")
        try:
            values.append(float(token))
        except ValueError:
            continue
    return values


def _date_values(text: str) -> set[str]:
    text = normalize_digits(text)
    values: set[str] = set()
    for regex in _date_patterns():
        for match in regex.finditer(text):
            key = _date_key(match.group(0))
            if key:
                values.add(key)
                # A yearless month/day spelling is an allowed formatting
                # variant of the same complete date, not an individual part.
                if len(key) == 10:
                    values.add(key[5:])
    for match in re.finditer(r"\b\d{4}-\d{2}-\d{2}(?:T[^\s,}]*)?", text):
        key = _date_key(match.group(0))
        if key:
            values.add(key)
            values.add(key[5:])
    return values


def _number_present(number: float, allowed: Iterable[float]) -> bool:
    return any(abs(number - candidate) < 1e-9 for candidate in allowed)


def verify_numbers(reply: str, user_text: str, tool_results: Iterable[Any]) -> bool:
    """Ensure every numeric/date token came from user text or tool results.

    Dates are compared as whole values. ``Mar 4`` may match an ISO date with
    the same month/day, but a standalone date component cannot be borrowed.
    """
    trusted = user_text + " " + " ".join(
        json.dumps(item, ensure_ascii=False, default=str) for item in tool_results
    )
    allowed_numbers = _numeric_values(trusted)
    allowed_dates = _date_values(trusted)
    if not _date_values(reply).issubset(allowed_dates):
        return False
    return all(_number_present(number, allowed_numbers) for number in _numeric_values(reply))


def _flatten_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [part for item in value.values() for part in _flatten_strings(item)]
    if isinstance(value, list):
        return [part for item in value for part in _flatten_strings(item)]
    return []


def verify_provenance(reply: str, user_text: str, tool_results: Iterable[Any]) -> bool:
    """Check directions and site-like proper nouns against trusted text.

    This is intentionally conservative only for domain-shaped terms; ordinary
    prose is left alone so an out-of-scope question is not rejected merely for
    containing an unrelated word.
    """
    trusted = user_text + " " + " ".join(
        json.dumps(item, ensure_ascii=False, default=str) for item in tool_results
    )
    lowered_reply = normalize_digits(reply).casefold()
    lowered_trusted = normalize_digits(trusted).casefold()
    for direction in _DIRECTION_WORDS:
        if re.search(rf"\b{re.escape(direction)}\b", lowered_reply) and not re.search(
            rf"\b{re.escape(direction)}\b", lowered_trusted
        ):
            return False
    # Site-like phrases are allowed only if the exact phrase occurs in the
    # user's request or a tool result. This catches invented names such as an
    # unsupported "Shackleton Rim" without classifying normal sentences.
    site_phrase = re.compile(
        r"\b[A-Z][A-Za-z0-9-]*(?:\s+[A-Za-z0-9-]+){0,2}\s+(?:site|rim|massif|ridge|plateau)\b"
    )
    for match in site_phrase.finditer(reply):
        phrase = re.sub(r"\s+", " ", match.group(0)).strip().casefold()
        if phrase and phrase not in lowered_trusted:
            return False
    return True


def _is_arabic(text: str) -> bool:
    return bool(re.search(r"[\u0600-\u06ff]", text))


def contains_unsafe_content(reply: str) -> bool:
    return bool(_FORBIDDEN_REPLY_RE.search(reply or ""))


def safe_reply(reply: str, user_text: str = "") -> str:
    """Return a refusal that does not repeat keys, prompts, or safety claims."""
    if not reply or contains_unsafe_content(reply):
        if _is_arabic(user_text or reply):
            return "أقدر أشرح نتائج الرؤية من محرك SHOTSPOT وأقارن المواقع والتواريخ المدعومة، لكن مش هقدر أشارك بيانات داخلية."
        return "I can explain SHOTSPOT visibility results and compare supported sites and dates, but I cannot disclose internal data."
    return reply.strip()


def append_default_assumptions(
    reply: str, tool_results: Iterable[dict[str, Any]], user_text: str = ""
) -> str:
    """Append native ``defaults_assumed`` exactly once when the LLM omitted it."""
    defaults: list[str] = []
    for result in tool_results:
        if not isinstance(result, dict):
            continue
        values = result.get("defaults_assumed")
        if isinstance(values, list):
            for value in values:
                if str(value) not in defaults:
                    defaults.append(str(value))
    if not defaults or re.search(r"assum|افتراض", reply, re.I):
        return reply
    if _is_arabic(user_text or reply):
        return reply.rstrip() + " افتراضات المحرك: " + "، ".join(defaults) + "."
    return reply.rstrip() + " Engine assumptions: " + ", ".join(defaults) + "."


def _fmt(value: Any) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _date_text(value: Any) -> str:
    return str(value or "")[:10]


def _first_dict(results: list[dict[str, Any]], *keys: str) -> dict[str, Any]:
    for result in results:
        current: Any = result
        for key in keys:
            current = current.get(key) if isinstance(current, dict) else None
        if isinstance(current, dict):
            return current
    return {}


def deterministic_template(
    tool_results: Iterable[dict[str, Any]], user_text: str = ""
) -> str:
    """Build a provenance-only fallback from native engine fields.

    The fallback deliberately uses only values already present in results. It
    includes metrics, failure reasons/why data, an engine-derived next step,
    and every reported default assumption. ``verified`` is set false by the
    router whenever this template is selected.
    """
    results = [result for result in tool_results if isinstance(result, dict)]
    if any(result.get("error") for result in results):
        if _is_arabic(user_text):
            return "المحرك ماكملش الفحص المطلوب. جرّب موقع أو تاريخ مدعوم من SHOTSPOT."
        return "The engine could not complete this check. Try a supported SHOTSPOT site or date."

    effective_value = next(
        (result.get("effective") for result in results if isinstance(result.get("effective"), dict)),
        {},
    )
    effective = effective_value if isinstance(effective_value, dict) else {}
    baseline = _first_dict(results, "baseline")
    metrics = _first_dict(([{"x": baseline}] if baseline else results), "x", "results_at_aim")
    if not metrics:
        metrics = _first_dict(results, "baseline", "results_at_aim")
    if not metrics:
        metrics_value = next(
            (result.get("results_at_aim") for result in results if isinstance(result.get("results_at_aim"), dict)),
            {},
        )
        metrics = metrics_value if isinstance(metrics_value, dict) else {}
    why_value = next((result.get("why") for result in results if isinstance(result.get("why"), dict)), {})
    why = why_value if isinstance(why_value, dict) else {}
    defaults: list[str] = []
    for result in results:
        for item in result.get("defaults_assumed", []) if isinstance(result.get("defaults_assumed"), list) else []:
            if item not in defaults:
                defaults.append(str(item))

    site = effective.get("site_name") or effective.get("site")
    date = _date_text(effective.get("start_date"))
    duration = effective.get("duration_days")
    verdict = str(metrics.get("verdict") or "").upper()
    sun = metrics.get("sun_visible_pct")
    earth = metrics.get("earth_visible_pct")
    failed = metrics.get("reasons_failed") or []
    conditions = metrics.get("conditions") or []
    if not failed:
        failed = [
            condition.get("condition")
            for condition in conditions
            if isinstance(condition, dict) and condition.get("ok") is False
        ]
    failed_days = why.get("failed_days") if isinstance(why, dict) else []
    blocking = why.get("blocking_ranges") if isinstance(why, dict) else []
    if not failed and isinstance(failed_days, list):
        failed = [
            str(condition)
            for day in failed_days
            if isinstance(day, dict)
            for condition in (day.get("failed_conditions") or [])
        ]

    next_step = "Review the returned engine result in Mission Studio."
    for result in results:
        alternatives = result.get("alternative_dates") or result.get("alternative_sites")
        if isinstance(alternatives, list) and alternatives:
            row = alternatives[0] if isinstance(alternatives[0], dict) else {}
            row_site = ((row.get("site") or {}).get("name") if isinstance(row.get("site"), dict) else row.get("site"))
            row_date = _date_text(row.get("start_date"))
            parts = ["Try the engine-ranked alternative"]
            if row_site:
                parts.append(str(row_site))
            if row_date:
                parts.append(f"on {row_date}")
            deltas = []
            for key in ("delta_sun_pct", "delta_earth_pct"):
                if row.get(key) is not None:
                    deltas.append(f"{key}={_fmt(row[key])}")
            next_step = " ".join(parts) + (" (" + ", ".join(deltas) + ")." if deltas else ".")
            break
        dispersion = result.get("dispersion")
        if not isinstance(dispersion, dict):
            nested_baseline = result.get("baseline")
            dispersion = nested_baseline.get("dispersion") if isinstance(nested_baseline, dict) else None
        if isinstance(dispersion, dict) and dispersion.get("best_aim_offset_m") is not None:
            next_step = f"Review the engine's best aim offset {dispersion['best_aim_offset_m']} m in Mission Studio."
            break

    if _is_arabic(user_text):
        lines = []
        if site and verdict:
            lines.append(f"النتيجة من المحرك: {site} {'بيعدّي' if verdict == 'PASS' else 'مش بيعدّي'} شروط الرؤية.")
        elif site:
            lines.append(f"نتيجة محرك SHOTSPOT للموقع {site} جاهزة للمراجعة.")
        if date:
            lines.append(f"التاريخ: {date}" + (f"، المدة: {_fmt(duration)} يوم." if duration is not None else "."))
        if sun is not None or earth is not None:
            parts = []
            if sun is not None:
                parts.append(f"Sun visibility {_fmt(sun)}%")
            if earth is not None:
                parts.append(f"Earth visibility {_fmt(earth)}%")
            lines.append("المقاييس: " + "، ".join(parts) + ".")
        if failed:
            lines.append("الأسباب: " + "، ".join(str(item) for item in failed) + ".")
        if failed_days:
            days = [str(item.get("date_utc"))[:10] for item in failed_days[:3] if isinstance(item, dict) and item.get("date_utc")]
            if days:
                lines.append("أيام التعثر: " + "، ".join(days) + ".")
        if blocking:
            bodies = [str(item.get("body")) + (f" عند azimuth {item['azimuth_start_deg']}–{item['azimuth_end_deg']}°" if item.get('azimuth_start_deg') is not None and item.get('azimuth_end_deg') is not None else '') for item in blocking[:2] if isinstance(item, dict) and item.get("body")]
            if bodies:
                lines.append("الحجب المسجل: " + "، ".join(bodies) + ".")
        if defaults:
            lines.append("افتراضات المحرك: " + "، ".join(defaults) + ".")
        lines.append("الخطوة التالية: " + next_step)
        return " ".join(lines) or "نتيجة محرك SHOTSPOT غير كافية لرد موثّق."

    lines = []
    if site and verdict:
        lines.append(f"Engine result: {site} {'passes' if verdict == 'PASS' else 'does not pass'} the visibility profile.")
    elif site:
        lines.append(f"SHOTSPOT engine result for {site} is ready for review.")
    if date:
        lines.append(f"Date: {date}" + (f"; duration: {_fmt(duration)} days." if duration is not None else "."))
    if sun is not None or earth is not None:
        parts = []
        if sun is not None:
            parts.append(f"Sun visibility {_fmt(sun)}%")
        if earth is not None:
            parts.append(f"Earth visibility {_fmt(earth)}%")
        lines.append("Metrics: " + "; ".join(parts) + ".")
    if failed:
        lines.append("Reasons: " + "; ".join(str(item) for item in failed) + ".")
    if failed_days:
        days = [_date_text(item.get("date_utc")) for item in failed_days[:3] if isinstance(item, dict) and item.get("date_utc")]
        if days:
            lines.append("Failed days: " + ", ".join(days) + ".")
    if blocking:
        bodies = [str(item.get("body")) + (f" azimuth {item['azimuth_start_deg']}–{item['azimuth_end_deg']}°" if item.get('azimuth_start_deg') is not None and item.get('azimuth_end_deg') is not None else '') for item in blocking[:2] if isinstance(item, dict) and item.get("body")]
        if bodies:
            lines.append("Blocking bodies: " + ", ".join(bodies) + ".")
    if defaults:
        lines.append("Engine assumptions: " + ", ".join(defaults) + ".")
    lines.append("Next step: " + next_step)
    return " ".join(lines) or "The SHOTSPOT engine returned no verifiable summary fields."
