#!/usr/bin/env python3
"""Pull timestamped transcript from the last call via Fly.io logs.

Usage:
    python scripts/call_transcript.py                    # last call, human-readable
    python scripts/call_transcript.py --raw              # last call, raw JSON
    python scripts/call_transcript.py --call-sid CA...   # specific call
    python scripts/call_transcript.py --gap-threshold 3  # custom gap threshold
    python scripts/call_transcript.py --since 2h         # look back 2 hours
"""

import argparse
import json
import shutil
import subprocess
import sys


def parse_transcript_lines(lines: list[str], call_sid: str | None = None) -> list[dict]:
    """Parse TRANSCRIPT_DUMP lines from log output into transcript dicts.

    Handles multi-chunk reassembly. Returns list of complete transcripts
    (most recent last). If call_sid is specified, filters to that call only.
    """
    chunk_groups: dict[int, dict[int, str]] = {}
    group_counter = 0

    for line in lines:
        if "TRANSCRIPT_DUMP|" not in line:
            continue

        idx = line.index("TRANSCRIPT_DUMP|")
        dump_part = line[idx:]

        parts = dump_part.split("|", 2)
        if len(parts) < 3:
            continue

        try:
            chunk_info = parts[1]
            chunk_num, total = chunk_info.split("/")
            chunk_num = int(chunk_num)
            total = int(total)
        except (ValueError, IndexError):
            continue

        if chunk_num == 1:
            group_counter += 1

        if group_counter not in chunk_groups:
            chunk_groups[group_counter] = {}
        chunk_groups[group_counter][chunk_num] = parts[2]

    transcripts = []
    for group_id in sorted(chunk_groups.keys()):
        chunks = chunk_groups[group_id]
        if not chunks:
            continue

        try:
            first = json.loads(chunks.get(1, "{}"))
        except json.JSONDecodeError:
            continue

        if call_sid and first.get("call_sid") != call_sid:
            continue

        all_entries = list(first.get("entries", []))
        for i in sorted(chunks.keys()):
            if i == 1:
                continue
            try:
                chunk_data = json.loads(chunks[i])
                all_entries.extend(chunk_data.get("entries", []))
            except json.JSONDecodeError:
                continue

        first["entries"] = all_entries
        transcripts.append(first)

    return transcripts


def format_transcript(transcript: dict, gap_threshold: float = 2.0) -> str:
    """Format a transcript dict into human-readable output with gap annotations."""
    lines = []

    sid = transcript.get("call_sid", "unknown")
    phone = transcript.get("phone", "unknown")
    duration = transcript.get("duration_s", 0)
    final_state = transcript.get("final_state", "unknown")
    lines.append(f"Call {sid} | {phone} | {duration}s | {final_state}")
    lines.append("\u2550" * 55)
    lines.append("")

    entries = transcript.get("entries", [])
    prev_t = None

    for entry in entries:
        t = entry.get("t", 0.0)
        role = entry.get("role", "")
        state = entry.get("state", "")

        if prev_t is not None:
            gap = t - prev_t
            if gap >= gap_threshold:
                if gap >= 5.0:
                    lines.append(f"      \u2506 +{gap:.1f}s \u26a0 SLOW")
                else:
                    lines.append(f"      \u2506 +{gap:.1f}s")

        state_tag = f"[{state}]" if state else ""
        t_str = f"{t:5.1f}s"

        if role == "agent":
            content = entry.get("content", "")
            lines.append(f"{t_str} {state_tag:<18} Agent: {content}")
        elif role == "user":
            content = entry.get("content", "")
            lines.append(f"{t_str} {state_tag:<18} Caller: {content}")
        elif role == "tool":
            name = entry.get("name", "unknown")
            result = entry.get("result", {})
            result_str = json.dumps(result)
            result_short = result_str if len(result_str) < 80 else result_str[:77] + "..."
            lines.append(f"{t_str} {state_tag:<18} \u2699 {name} \u2192 {result_short}")

        prev_t = t

    if entries:
        lines.append(f"{duration:5.1f}s {'':18} \u260e Call ended")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Pull timestamped transcript from last call")
    parser.add_argument("--raw", action="store_true", help="Output raw JSON")
    parser.add_argument("--call-sid", type=str, default=None, help="Filter by specific call SID")
    parser.add_argument("--gap-threshold", type=float, default=2.0, help="Gap threshold in seconds (default: 2.0)")
    parser.add_argument("--since", type=str, default="1h", help="How far back to search (default: 1h)")
    parser.add_argument("--app", type=str, default="calllock-voice", help="Fly.io app name")
    args = parser.parse_args()

    if not shutil.which("fly") and not shutil.which("flyctl"):
        print("Error: flyctl not found. Install: https://fly.io/docs/flyctl/install/", file=sys.stderr)
        sys.exit(1)

    fly_cmd = "fly" if shutil.which("fly") else "flyctl"

    try:
        result = subprocess.run(
            [fly_cmd, "logs", "-a", args.app, "--no-tail", "--since", args.since],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError:
        print("Error: flyctl not found. Install: https://fly.io/docs/flyctl/install/", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print("Error: fly logs timed out after 30s", file=sys.stderr)
        sys.exit(1)

    if result.returncode != 0:
        stderr = result.stderr.strip()
        if "not authenticated" in stderr.lower() or "login" in stderr.lower():
            print("Error: Not authenticated with Fly.io. Run: fly auth login", file=sys.stderr)
        else:
            print(f"Error: fly logs failed: {stderr}", file=sys.stderr)
        sys.exit(1)

    lines = result.stdout.strip().split("\n")

    transcripts = parse_transcript_lines(lines, call_sid=args.call_sid)

    if not transcripts:
        print(f"No recent calls found in the last {args.since}. Try --since 2h", file=sys.stderr)
        sys.exit(1)

    transcript = transcripts[-1]

    if args.raw:
        print(json.dumps(transcript, indent=2))
    else:
        print(format_transcript(transcript, gap_threshold=args.gap_threshold))


if __name__ == "__main__":
    main()
