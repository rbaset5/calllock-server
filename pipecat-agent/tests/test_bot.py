from unittest.mock import patch

# bot.py calls validate_config() at import time, which sys.exit(1) if env vars missing.
# Patch it so the import succeeds in test environment.
with patch("calllock.config.validate_config"):
    from calllock.bot import _startframe_noise_filter


class TestStartFrameNoiseFilter:
    def test_suppresses_startframe_from_frame_processor(self):
        record = {"name": "pipecat.processors.frame_processor", "message": "InworldHttpTTSService#0 Trying to process TTSTextFrame but StartFrame not received yet"}
        assert _startframe_noise_filter(record) is False

    def test_allows_real_errors_from_frame_processor(self):
        record = {"name": "pipecat.processors.frame_processor", "message": "Real error in frame processing"}
        assert _startframe_noise_filter(record) is True

    def test_allows_startframe_text_from_other_modules(self):
        record = {"name": "calllock.processor", "message": "StartFrame not received"}
        assert _startframe_noise_filter(record) is True
