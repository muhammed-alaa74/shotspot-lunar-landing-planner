"""Typed tool adapters over ``backend.engine_api.EngineAPI``.

This module translates human/LLM arguments to the native engine contract. It
never reimplements engine calculations or trusts free-form assistant text.
"""
from __future__ import annotations

import datetime as dt
import difflib
import re
from typing import Any, Callable

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


class ToolModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ProfileArgs(ToolModel):
    # Native names remain the model field names. Human-friendly snake_case
    # aliases are accepted at the LLM boundary and converted below.
    minSun: float | None = Field(
        default=None, ge=0, le=100, validation_alias=AliasChoices("minSun", "min_sun_pct")
    )
    minEarth: float | None = Field(
        default=None, ge=0, le=100, validation_alias=AliasChoices("minEarth", "min_earth_pct")
    )
    maxSunGap: float | None = Field(
        default=None,
        ge=0,
        le=8760,
        validation_alias=AliasChoices("maxSunGap", "max_sun_gap_h", "max_sun_outage_h"),
    )
    maxEarthGap: float | None = Field(
        default=None,
        ge=0,
        le=8760,
        validation_alias=AliasChoices(
            "maxEarthGap", "max_earth_gap_h", "max_earth_outage_h"
        ),
    )
    maxSlope: float | None = Field(
        default=None,
        ge=0,
        le=90,
        validation_alias=AliasChoices("maxSlope", "max_slope_deg"),
    )
    conservative: bool | None = None


class SiteArgs(ToolModel):
    site: str = Field(min_length=1, max_length=160)
    start_date: str | None = Field(default=None, max_length=40)
    duration_days: float | None = Field(default=None, gt=0, le=365)

    @field_validator("start_date")
    @classmethod
    def valid_date(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            dt.date.fromisoformat(value[:10])
        except ValueError as exc:
            raise ValueError("start_date must be an ISO date") from exc
        return value


class BaselineArgs(SiteArgs):
    profile: ProfileArgs | None = None
    drift_m: float | None = Field(default=None, ge=0, le=500)
    aim_index: int | None = Field(default=None, ge=0)


class CompareItem(ToolModel):
    site: str = Field(min_length=1, max_length=160)
    start_date: str | None = Field(default=None, max_length=40)

    @field_validator("start_date")
    @classmethod
    def valid_date(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            dt.date.fromisoformat(value[:10])
        except ValueError as exc:
            raise ValueError("start_date must be an ISO date") from exc
        return value


class CompareArgs(ToolModel):
    items: list[CompareItem] = Field(min_length=2, max_length=20)
    duration_days: float | None = Field(default=None, gt=0, le=365)


class ScenarioArgs(BaselineArgs):
    arrival_delay_days: float | None = Field(default=None, ge=0, le=365)
    landing_shift_m: dict[str, float] | None = None


class AlternativesArgs(SiteArgs):
    max_delay_days: float | None = Field(default=None, ge=0, le=60)
    min_sun_pct: float | None = Field(default=None, ge=0, le=100)
    min_earth_pct: float | None = Field(default=None, ge=0, le=100)
    top_n: int | None = Field(default=None, ge=1, le=5)


class DispersionArgs(SiteArgs):
    drift_m: float | None = Field(default=None, ge=0, le=500)
    aim_index: int | None = Field(default=None, ge=0)


_ENGINE: Any = None
_UNSUPPORTED_SITE_REFERENCES = ("shackleton", "nobile", "de gerlache", "amundsen")


def set_engine_for_testing(engine: Any) -> None:
    global _ENGINE
    _ENGINE = engine


def _engine() -> Any:
    global _ENGINE
    if _ENGINE is None:
        try:
            from backend.engine_api import EngineAPI
        except Exception as exc:  # pragma: no cover - adapter supplied by sibling agent
            raise RuntimeError("SHOTSPOT engine is not configured") from exc
        _ENGINE = EngineAPI()
    return _ENGINE


def _call(name: str, args: dict[str, Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
    result = _engine().call(name, args, context=context)
    if not isinstance(result, dict):
        raise RuntimeError("Engine returned an invalid result")
    return result


def list_sites() -> dict[str, Any]:
    return _call("list_sites", {})


def _site_catalog() -> list[dict[str, Any]]:
    result = list_sites()
    return [item for item in result.get("sites", []) if isinstance(item, dict)]


def resolve_site(value: str) -> str:
    requested = re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()
    catalog = _site_catalog()
    choices = [(str(item.get("id", "")), str(item.get("name", ""))) for item in catalog]
    for site_id, name in choices:
        if requested in {site_id.casefold(), name.casefold()}:
            return site_id
    for site_id, name in choices:
        norm = re.sub(r"[^a-z0-9]+", " ", name.casefold()).strip()
        if requested and (requested in norm or norm in requested):
            return site_id
    if any(reference in requested for reference in _UNSUPPORTED_SITE_REFERENCES):
        valid = ", ".join(name for _, name in choices if name)
        raise ValueError(f"Unknown site. Valid sites: {valid or 'none available'}")
    normalized_names = [re.sub(r"[^a-z0-9]+", " ", n.casefold()).strip() for _, n in choices]
    match = difflib.get_close_matches(requested, normalized_names, n=1, cutoff=0.55)
    if match:
        return choices[normalized_names.index(match[0])][0]
    valid = ", ".join(name for _, name in choices if name)
    raise ValueError(f"Unknown site. Valid sites: {valid or 'none available'}")


def _default_date(site_id: str) -> str | None:
    for item in _site_catalog():
        if str(item.get("id")) == site_id:
            coverage = item.get("coverage") or {}
            return str(
                coverage.get("start")
                or item.get("coverage_start")
                or item.get("coverage_start_utc")
                or ""
            ) or None
    return None


def _base_args(model: SiteArgs) -> dict[str, Any]:
    site_id = resolve_site(model.site)
    payload: dict[str, Any] = {"site": site_id}
    if model.start_date is not None:
        payload["start_date"] = model.start_date
    if model.duration_days is not None:
        payload["duration_days"] = model.duration_days
    return payload


def _profile_dict(profile: ProfileArgs | None) -> dict[str, Any] | None:
    return profile.model_dump(by_alias=False, exclude_none=True) if profile else None


def get_baseline(args: dict[str, Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
    model = BaselineArgs.model_validate(args)
    payload = _base_args(model)
    if model.profile:
        payload["profile"] = _profile_dict(model.profile)
    if model.drift_m is not None:
        payload["drift_m"] = model.drift_m
    if model.aim_index is not None:
        payload["aim_index"] = model.aim_index
    return _call("get_baseline", payload, context=context)


def compare(args: dict[str, Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
    model = CompareArgs.model_validate(args)
    items = []
    for item in model.items:
        site_id = resolve_site(item.site)
        context_date = context.get("date") if isinstance(context, dict) else None
        items.append({"site": site_id, "start_date": item.start_date or context_date or _default_date(site_id)})
    payload: dict[str, Any] = {"items": items}
    if model.duration_days is not None:
        payload["duration_days"] = model.duration_days
    return _call("compare", payload, context=context)


def run_scenario(args: dict[str, Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
    model = ScenarioArgs.model_validate(args)
    payload = _base_args(model)
    if model.arrival_delay_days is not None:
        payload["arrival_delay_days"] = model.arrival_delay_days
    if model.landing_shift_m is not None:
        payload["landing_shift_m"] = model.landing_shift_m
    if model.profile:
        payload["profile"] = _profile_dict(model.profile)
    if model.drift_m is not None:
        payload["drift_m"] = model.drift_m
    if model.aim_index is not None:
        payload["aim_index"] = model.aim_index
    return _call("run_scenario", payload, context=context)


def find_alternatives(args: dict[str, Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
    model = AlternativesArgs.model_validate(args)
    payload = _base_args(model)
    for key, value in (
        ("max_delay_days", model.max_delay_days),
        ("min_sun_pct", model.min_sun_pct),
        ("min_earth_pct", model.min_earth_pct),
        ("top_n", model.top_n),
    ):
        if value is not None:
            payload[key] = value
    return _call("find_alternatives", payload, context=context)


def dispersion(args: dict[str, Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
    model = DispersionArgs.model_validate(args)
    payload = _base_args(model)
    if model.drift_m is not None:
        payload["drift_m"] = model.drift_m
    if model.aim_index is not None:
        payload["aim_index"] = model.aim_index
    return _call("dispersion", payload, context=context)


TOOL_FUNCTIONS: dict[str, Callable[..., dict[str, Any]]] = {
    "list_sites": lambda args, context=None: list_sites(),
    "get_baseline": get_baseline,
    "compare": compare,
    "run_scenario": run_scenario,
    "find_alternatives": find_alternatives,
    "dispersion": dispersion,
}


def execute_tool(
    name: str, args: dict[str, Any], context: dict[str, Any] | None = None
) -> dict[str, Any]:
    function = TOOL_FUNCTIONS.get(name)
    if function is None:
        return {"error": "Unknown Copilot tool"}
    try:
        return function(args, context=context)
    except ValueError as exc:
        # Pydantic and native validation messages are useful recovery hints,
        # but they contain no traceback or provider details.
        return {"error": str(exc)[:500]}
    except Exception:
        return {
            "error": "The engine could not complete that request. Check the site, date, and ranges and try again."
        }
