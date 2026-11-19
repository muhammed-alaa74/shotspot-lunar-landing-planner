from __future__ import annotations

import math
from pathlib import Path
from collections.abc import Iterator

import pytest

from backend.engine_api import EngineAPI


ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def api() -> Iterator[EngineAPI]:
    engine = EngineAPI(data_dir=ROOT / "web" / "data")
    yield engine
    engine.close()


def test_list_sites_uses_only_computed_catalog(api: EngineAPI) -> None:
    result = api.call("list_sites", {})
    assert result["tool"] == "list_sites"
    assert result["effective"] == {}
    assert [site["name"] for site in result["sites"]] == [
        "Leibnitz beta plateau",
        "Connecting ridge",
        "Malapert massif",
    ]
    assert result["defaults"]["duration_days"] == 10
    assert result["defaults"]["drift_m"] == 100
    assert {item["term"] for item in result["glossary"]} >= {"elevation", "azimuth", "drift"}


def test_baseline_is_native_shaped_and_returns_copies(api: EngineAPI) -> None:
    args = {"site": "Site20", "start_date": "2026-11-15T00:00:00Z", "duration_days": 1}
    first = api.call("get_baseline", args)
    assert first["effective"]["site_name"] == "Leibnitz beta plateau"
    assert first["effective"]["duration_days"] == 1
    assert first["effective"]["drift_m"] == 100
    assert first["defaults_assumed"] == ["drift_m=100", "profile"]
    baseline = first["baseline"]
    assert set(baseline) >= {"site", "window", "mission_profile", "results_at_aim", "dispersion", "assumptions", "sources"}
    assert set(first) >= {"daily_series", "sky", "why", "countdowns"}
    assert first["sky"]["sun"][0].keys() == {"utc", "azimuth_deg", "elevation_deg"}
    assert first["sky"]["earth"][0].keys() == {"utc", "azimuth_deg", "elevation_deg"}
    assert first["sky"]["horizon"][0].keys() == {"azimuth_deg", "elevation_deg"}
    assert len(first["sky"]["horizon"]) == 361
    assert len(first["daily_series"]) == 2  # inclusive endpoint, as Store.applyWindow uses it
    assert all(math.isfinite(value) for value in [baseline["results_at_aim"]["sun_visible_pct"], baseline["results_at_aim"]["earth_visible_pct"]])

    first["baseline"]["results_at_aim"]["sun_visible_pct"] = -123
    second = api.call("get_baseline", args)
    assert second["baseline"]["results_at_aim"]["sun_visible_pct"] != -123


def test_defaults_context_and_fuzzy_matching(api: EngineAPI) -> None:
    result = api.call("dispersion", {"site": "malapert massi", "start_date": "2026-11-15", "duration_days": 1}, {"aimIndex": 3280})
    assert result["effective"]["site"] == "Site23"
    assert result["effective"]["aim_index"] == 3280
    assert result["defaults_assumed"] == ["drift_m=100", "profile"]

    with pytest.raises(ValueError, match="Valid site names:.*Leibnitz beta plateau"):
        api.call("get_baseline", {"site": "Shackleton Rim", "duration_days": 1})


def test_validation_is_strict_and_errors_are_sanitized(api: EngineAPI) -> None:
    with pytest.raises(ValueError, match="between 0 and 500"):
        api.call("dispersion", {"site": "Site20", "duration_days": 1, "drift_m": 501})
    with pytest.raises(ValueError, match="between 0 and 100"):
        api.call("get_baseline", {"site": "Site20", "duration_days": 1, "profile": {"minSun": 101}})
    with pytest.raises(ValueError, match="fit native coverage"):
        api.call("get_baseline", {"site": "Site20", "start_date": "2027-11-15", "duration_days": 1})
    with pytest.raises(ValueError, match="Valid site names") as exc:
        api.call("get_baseline", {"site": "Nobile Rim", "duration_days": 1})
    assert "backend" not in str(exc.value)
    assert "Traceback" not in str(exc.value)


def test_scenario_compare_alternatives_and_dispersion(api: EngineAPI) -> None:
    scenario = api.call("run_scenario", {"site": "Site20", "start_date": "2026-11-15", "duration_days": 1, "arrival_delay_days": 1, "landing_shift_m": {"x": 30, "y": 0}})
    assert set(scenario) >= {"baseline", "shifted", "deltas", "landing_shift"}
    assert scenario["landing_shift"]["offset_m"] == [30, 0]
    assert set(scenario["deltas"]) >= {"sun_visible_pct", "earth_visible_pct", "pass_changed"}

    compared = api.call("compare", {"items": [{"site": "Site20", "start_date": "2026-11-15"}, {"site": "Site01", "start_date": "2026-11-15"}], "duration_days": 1})
    assert len(compared["rows"]) == 2
    assert len(compared["shared_timeline"]) == 145
    assert compared["rows"][0]["effective"]["site"] in {"Site20", "Site01"}

    alternatives = api.call("find_alternatives", {"site": "Site20", "start_date": "2026-11-15", "duration_days": 1, "max_delay_days": 1, "top_n": 2})
    assert len(alternatives["alternative_dates"]) <= 1
    assert len(alternatives["alternative_sites"]) == 2
    assert all("delta_sun_pct" in row and "delta_earth_pct" in row for row in alternatives["alternative_sites"])

    dispersion = api.call("dispersion", {"site": "Site20", "start_date": "2026-11-15", "duration_days": 1, "drift_m": 25})
    assert len(dispersion["curve"]) == 21
    assert dispersion["dispersion"]["curve"] == dispersion["curve"]


def test_daily_partition_uses_each_native_sample_once(api: EngineAPI) -> None:
    result = api.call('get_baseline', {'site':'Site20','start_date':'2026-12-13','duration_days':1})
    for body, windows in [('sun','sun_windows'),('earth','earth_windows')]:
        counted = sum(day[f'{body}_visible_minutes'] for day in result['daily_series'])
        native = sum(window['minutes'] for window in result['baseline']['results_at_aim'][windows])
        assert counted == native


def test_rescue_caps_future_search_at_coverage_end(api: EngineAPI) -> None:
    result = api.call('find_alternatives', {'site':'Site20','start_date':'2027-11-13','duration_days':1,'max_delay_days':14})
    assert result['search']['coverage_limited'] is True
    assert result['search']['same_site_days'] == 1
    assert len(result['alternative_dates']) <= 1
    assert all(row['delta_sun_pct'] is not None and row['delta_earth_pct'] is not None for row in result['alternative_sites'])


def test_context_aim_is_not_reused_for_a_different_site(api: EngineAPI) -> None:
    context = {'site':'Site20','date':'2026-12-13T12:00:00Z','aimIndex':100,'durationDays':1,
               'profile':{'minSun':65,'minEarth':75,'maxEarthGap':12,'maxSunGap':30,'maxSlope':5,'conservative':True}}
    result = api.call('run_scenario',{'site':'Site23','profile':{'minSun':80}}, context)
    assert result['effective']['aim_index'] == 3280
    assert result['effective']['profile']['minSun'] == 80
    assert result['effective']['profile']['maxEarthGap'] == 12
    assert result['effective']['profile']['conservative'] is True
    assert result['effective']['start_date'] == '2026-12-13T12:00:00.000Z'


def test_action_uses_validated_landing_shift_target(api: EngineAPI) -> None:
    from backend.copilot.router import _actions
    result = api.call('run_scenario',{'site':'Site20','start_date':'2026-12-13T12:00:00Z','duration_days':1,'landing_shift_m':{'x':30,'y':0}})
    actions = _actions([{'tool':'run_scenario','args':{},'result':result}])
    assert actions[0].payload.aimIndex == result['landing_shift']['shifted_aim_index']
    assert actions[0].payload.startDate == result['effective']['start_date']
