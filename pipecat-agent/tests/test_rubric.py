import pytest
from tests.eval_data.rubric import (
    compute_weighted_score,
    parse_judge_scores,
    DIMENSIONS,
    PASS_THRESHOLD,
)


class TestWeightedScore:
    def test_perfect_score(self):
        scores = {dim: 5 for dim in DIMENSIONS}
        assert compute_weighted_score(scores) == 5.0

    def test_minimum_score(self):
        scores = {dim: 1 for dim in DIMENSIONS}
        assert compute_weighted_score(scores) == 1.0

    def test_threshold_boundary(self):
        # All 4s except one 1 — should still pass
        scores = {dim: 4 for dim in DIMENSIONS}
        scores["forbidden_words"] = 1  # weight 0.10
        result = compute_weighted_score(scores)
        assert result >= PASS_THRESHOLD

    def test_missing_dimension_defaults_to_1(self):
        scores = {"brevity": 5}  # only one dimension provided
        result = compute_weighted_score(scores)
        # brevity=5*0.20 + all others=1*0.80 = 1.80
        assert result == 1.8

    def test_weights_sum_to_one(self):
        total = sum(DIMENSIONS.values())
        assert abs(total - 1.0) < 0.001


class TestParseJudgeScores:
    VALID_SCORES = (
        '{"brevity": 4, "paraphrasing": 3, "forbidden_words": 5, '
        '"state_compliance": 4, "persona_fidelity": 3, '
        '"tone_matching": 4, "spoken_flow": 4}'
    )

    def test_clean_json(self):
        scores = parse_judge_scores(self.VALID_SCORES)
        assert scores["brevity"] == 4
        assert len(scores) == 7

    def test_markdown_fenced_json(self):
        fenced = f"```json\n{self.VALID_SCORES}\n```"
        scores = parse_judge_scores(fenced)
        assert scores["brevity"] == 4

    def test_extra_whitespace(self):
        padded = f"\n\n  {self.VALID_SCORES}  \n\n"
        scores = parse_judge_scores(padded)
        assert scores["brevity"] == 4

    def test_malformed_json_raises(self):
        with pytest.raises(ValueError, match="invalid JSON"):
            parse_judge_scores("not json at all")

    def test_missing_dimension_raises(self):
        partial = '{"brevity": 4}'
        with pytest.raises(ValueError, match="missing dimension"):
            parse_judge_scores(partial)

    def test_out_of_range_score_raises(self):
        bad = self.VALID_SCORES.replace('"brevity": 4', '"brevity": 6')
        with pytest.raises(ValueError, match="out of range"):
            parse_judge_scores(bad)

    def test_non_dict_raises(self):
        with pytest.raises(ValueError, match="expected dict"):
            parse_judge_scores("[1, 2, 3]")
