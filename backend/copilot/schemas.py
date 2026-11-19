"""Public Copilot API schemas.

Aliases preserve the existing Mission Studio camelCase fields while tool
arguments remain snake_case at the LLM boundary and native engine fields stay
camelCase inside validated profiles.
"""
from __future__ import annotations

from typing import Any, Literal, Union

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Message(StrictModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class Profile(StrictModel):
    """Mission Studio profile with native names and human snake_case aliases."""

    minSun: float | None = Field(
        default=None,
        ge=0,
        le=100,
        validation_alias=AliasChoices("minSun", "min_sun_pct"),
    )
    minEarth: float | None = Field(
        default=None,
        ge=0,
        le=100,
        validation_alias=AliasChoices("minEarth", "min_earth_pct"),
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


class Context(StrictModel):
    site: str | None = Field(default=None, max_length=160)
    date: str | None = Field(default=None, max_length=40)
    durationDays: float | None = Field(default=None, gt=0, le=365)
    profile: Profile | None = None
    driftM: float | None = Field(default=None, ge=0, le=500)
    aimIndex: int | None = Field(default=None, ge=0)
    arrivalDelayDays: float | None = Field(default=None, ge=0, le=365)


class CopilotRequest(StrictModel):
    messages: list[Message] = Field(min_length=1, max_length=10)
    context: Context | None = None

    @field_validator("messages")
    @classmethod
    def require_user_message(cls, value: list[Message]) -> list[Message]:
        if not any(message.role == "user" for message in value):
            raise ValueError("messages must include a user message")
        return value


class SetScenarioPayload(StrictModel):
    site: str = Field(min_length=1, max_length=160)
    startDate: str = Field(min_length=1, max_length=40)
    durationDays: float = Field(gt=0, le=365)
    minSunPct: float = Field(ge=0, le=100)
    minEarthPct: float = Field(ge=0, le=100)
    maxEarthOutageH: float = Field(ge=0, le=8760)
    driftM: float = Field(ge=0, le=500)
    arrivalDelayDays: float = Field(ge=0, le=365)
    # Preserve explicitly changed native profile fields and aim selection when
    # the action is applied to Mission Studio.
    profile: Profile | None = None
    aimIndex: int | None = Field(default=None, ge=0)


class OpenCompareItem(StrictModel):
    site: str = Field(min_length=1, max_length=160)
    startDate: str = Field(min_length=1, max_length=40)


class OpenComparePayload(StrictModel):
    items: list[OpenCompareItem] = Field(min_length=2, max_length=20)


class GoToStepPayload(StrictModel):
    step: Literal["aim", "drift", "better-aim", "move", "explore"]


class SetScenarioAction(StrictModel):
    type: Literal["set_scenario"]
    payload: SetScenarioPayload


class OpenCompareAction(StrictModel):
    type: Literal["open_compare"]
    payload: OpenComparePayload


class GoToStepAction(StrictModel):
    type: Literal["go_to_step"]
    payload: GoToStepPayload


Action = Union[SetScenarioAction, OpenCompareAction, GoToStepAction]


class ToolCall(StrictModel):
    tool: str
    args: dict[str, Any]
    result: dict[str, Any]


class SiteSummary(StrictModel):
    id: str
    name: str
    coverage: dict[str, str] | None = None
    coverage_start_utc: str | None = None
    coverage_end_utc: str | None = None
    description: str | None = None
    source: str | None = None


class SitesResponse(StrictModel):
    sites: list[SiteSummary]
    defaults: dict[str, Any] | None = None
    glossary: list[dict[str, Any]] = Field(default_factory=list)


class CopilotResponse(StrictModel):
    reply: str
    actions: list[Action] = Field(default_factory=list)
    toolCalls: list[ToolCall] = Field(default_factory=list)
    verified: bool
