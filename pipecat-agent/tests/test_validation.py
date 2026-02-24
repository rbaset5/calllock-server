from calllock.validation import (
    validate_zip,
    validate_name,
    validate_address,
    is_service_area,
    classify_intent,
    detect_safety_emergency,
    detect_high_ticket,
    match_any_keyword,
    resolve_booking_time,
)
from unittest.mock import patch
from datetime import datetime
from zoneinfo import ZoneInfo


class TestValidateZip:
    def test_valid_zip(self):
        assert validate_zip("78745") == "78745"

    def test_valid_zip_787_prefix(self):
        assert validate_zip("78701") == "78701"

    def test_rejects_partial_zip(self):
        assert validate_zip("787") == ""

    def test_rejects_non_numeric(self):
        assert validate_zip("abcde") == ""

    def test_rejects_six_digits(self):
        assert validate_zip("787456") == ""

    def test_rejects_empty(self):
        assert validate_zip("") == ""

    def test_rejects_none(self):
        assert validate_zip(None) == ""

    def test_strips_whitespace(self):
        assert validate_zip(" 78745 ") == "78745"


class TestValidateName:
    def test_valid_name(self):
        assert validate_name("Jonas") == "Jonas"

    def test_rejects_phone_number(self):
        assert validate_name("+15125551234") == ""

    def test_rejects_phone_digits_only(self):
        assert validate_name("5125551234") == ""

    def test_rejects_not_provided(self):
        assert validate_name("Not provided") == ""

    def test_rejects_na(self):
        assert validate_name("N/A") == ""

    def test_rejects_unknown(self):
        assert validate_name("unknown") == ""

    def test_rejects_empty(self):
        assert validate_name("") == ""

    def test_rejects_none(self):
        assert validate_name(None) == ""

    def test_rejects_placeholder_template(self):
        assert validate_name("{{customer_name}}") == ""


class TestIsServiceArea:
    def test_787_prefix_in_area(self):
        assert is_service_area("78745") is True

    def test_non_787_out_of_area(self):
        assert is_service_area("90210") is False

    def test_empty_zip_not_in_area(self):
        assert is_service_area("") is False


class TestClassifyIntent:
    def test_ac_is_service(self):
        assert classify_intent("my AC is broken") == "service"

    def test_billing_is_non_service(self):
        assert classify_intent("I have a billing question") == "non_service"

    def test_vendor_is_non_service(self):
        assert classify_intent("I'm a parts supplier") == "non_service"

    def test_hiring_is_non_service(self):
        assert classify_intent("are you hiring") == "non_service"

    def test_ambiguous_defaults_to_service(self):
        assert classify_intent("hello") == "service"


class TestDetectSafetyEmergency:
    def test_gas_smell(self):
        assert detect_safety_emergency("I smell gas") is True

    def test_burning(self):
        assert detect_safety_emergency("something is burning") is True

    def test_co_alarm(self):
        assert detect_safety_emergency("my CO detector is going off") is True

    def test_normal_issue(self):
        assert detect_safety_emergency("my AC isn't cooling") is False


class TestMatchAnyKeyword:
    def test_exact_word_matches(self):
        assert match_any_keyword("no", {"no"}) is True

    def test_word_at_start(self):
        assert match_any_keyword("no I don't", {"no"}) is True

    def test_word_at_end(self):
        assert match_any_keyword("I said no", {"no"}) is True

    def test_substring_does_not_match(self):
        assert match_any_keyword("it's not working", {"no"}) is False

    def test_substring_noticed_does_not_match(self):
        assert match_any_keyword("I noticed some smoke", {"no"}) is False

    def test_substring_know_does_not_match(self):
        assert match_any_keyword("how do you know my name", {"no"}) is False

    def test_multi_word_keyword(self):
        assert match_any_keyword("nothing like that happened", {"nothing like that"}) is True

    def test_multiple_keywords_first_matches(self):
        assert match_any_keyword("yeah sure", {"yes", "yeah", "sure"}) is True

    def test_no_match_returns_false(self):
        assert match_any_keyword("the fan is broken", {"no", "nope"}) is False

    def test_case_insensitive(self):
        assert match_any_keyword("NO way", {"no"}) is True

    def test_empty_text(self):
        assert match_any_keyword("", {"no"}) is False

    # Voice transcription edge cases (review finding T2)
    def test_contraction_dont_no_match(self):
        assert match_any_keyword("I don't think so", {"no"}) is False

    def test_hyphenated_no_match(self):
        """'no' before hyphen is a word boundary — should match."""
        assert match_any_keyword("no-name brand", {"no"}) is True

    def test_keyword_followed_by_comma(self):
        assert match_any_keyword("no, that's fine", {"no"}) is True

    def test_keyword_followed_by_period(self):
        assert match_any_keyword("I said no.", {"no"}) is True


class TestValidateAddress:
    def test_valid_street_address(self):
        assert validate_address("123 Main Street") == "123 Main Street"

    def test_valid_short_address(self):
        assert validate_address("42 Elm St") == "42 Elm St"

    def test_rejects_pure_digits_4(self):
        """Rejects ZIP fragments that land in address field."""
        assert validate_address("7801") == ""

    def test_rejects_pure_digits_5(self):
        assert validate_address("78001") == ""

    def test_rejects_too_short_3_chars(self):
        assert validate_address("Oak") == ""

    def test_rejects_too_short_4_chars(self):
        assert validate_address("1 Rk") == ""

    def test_accepts_5_chars_with_letters(self):
        """Boundary: 5 chars with at least one letter passes."""
        assert validate_address("1 Elm") == "1 Elm"

    def test_rejects_empty(self):
        assert validate_address("") == ""

    def test_rejects_none(self):
        assert validate_address(None) == ""

    def test_rejects_sentinel(self):
        assert validate_address("not provided") == ""

    def test_rejects_or_ambiguity(self):
        assert validate_address("123 Main or 456 Oak") == ""

    def test_normalizes_mixed_digit_word_street_number(self):
        """'53 Eleven Izzical Road' → '5311 Izzical Road'"""
        assert validate_address("53 Eleven Izzical Road") == "5311 Izzical Road"

    def test_normalizes_digit_then_word(self):
        """'4 Two Six Elm St' → '426 Elm St'"""
        assert validate_address("4 Two Six Elm St") == "426 Elm St"

    def test_leaves_already_numeric_alone(self):
        """'5311 Main St' → '5311 Main St' (no change)"""
        assert validate_address("5311 Main St") == "5311 Main St"

    def test_stops_at_non_number_word(self):
        """'Five Oak Lane' → '5 Oak Lane' (stops at 'Oak')"""
        assert validate_address("Five Oak Lane") == "5 Oak Lane"

    def test_oh_as_zero_in_address(self):
        """'5 Oh Three Main St' → '503 Main St'"""
        assert validate_address("5 Oh Three Main St") == "503 Main St"


class TestDetectHighTicket:
    def test_replacement(self):
        assert detect_high_ticket("I want a new AC system") is True

    def test_quote(self):
        assert detect_high_ticket("can I get a quote for a new unit") is True

    def test_repair(self):
        assert detect_high_ticket("my thermostat is broken") is False


class TestResolveBookingTime:
    """resolve_booking_time maps human text to ISO datetime strings."""

    CST = ZoneInfo("America/Chicago")

    def _freeze(self, year=2026, month=2, day=23, hour=10, minute=0):
        return datetime(year, month, day, hour, minute, tzinfo=self.CST)

    def test_asap_returns_2h_ahead_truncated(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10, minute=15)):
            result = resolve_booking_time("ASAP")
        assert "2026-02-23T12:00:00" in result

    def test_today_returns_2h_ahead_truncated(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=9, minute=30)):
            result = resolve_booking_time("today")
        assert "2026-02-23T11:00:00" in result

    def test_soonest_same_as_asap(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10, minute=15)):
            result = resolve_booking_time("soonest")
        assert "2026-02-23T12:00:00" in result

    def test_right_away_same_as_asap(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10, minute=15)):
            result = resolve_booking_time("right away")
        assert "2026-02-23T12:00:00" in result

    def test_same_day_treated_as_asap(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10, minute=15)):
            result = resolve_booking_time("same day")
        assert "2026-02-23T12:00:00" in result

    def test_morning_treated_as_asap(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=8, minute=0)):
            result = resolve_booking_time("morning")
        assert "2026-02-23T10:00:00" in result

    def test_late_evening_asap_goes_next_morning(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=19)):
            result = resolve_booking_time("ASAP")
        assert "2026-02-24T09:00:00" in result

    def test_tomorrow_returns_9am(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=15)):
            result = resolve_booking_time("tomorrow")
        assert "2026-02-24T09:00:00" in result

    def test_tomorrow_morning_returns_9am(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=15)):
            result = resolve_booking_time("tomorrow morning")
        assert "2026-02-24T09:00:00" in result

    def test_this_afternoon_before_2pm(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10)):
            result = resolve_booking_time("this afternoon")
        assert "2026-02-23T14:00:00" in result

    def test_this_afternoon_after_2pm_goes_tomorrow(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=15)):
            result = resolve_booking_time("this afternoon")
        assert "2026-02-24T14:00:00" in result

    def test_this_week_returns_next_day_9am(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10)):
            result = resolve_booking_time("this week")
        assert "2026-02-24T09:00:00" in result

    def test_whenever_returns_next_day_9am(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10)):
            result = resolve_booking_time("whenever")
        assert "2026-02-24T09:00:00" in result

    def test_empty_returns_next_day_9am(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10)):
            result = resolve_booking_time("")
        assert "2026-02-24T09:00:00" in result

    def test_unknown_text_falls_through_to_default(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10)):
            result = resolve_booking_time("next week")
        assert "2026-02-24T09:00:00" in result

    def test_result_is_valid_iso_format(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10)):
            result = resolve_booking_time("ASAP")
        datetime.fromisoformat(result)
