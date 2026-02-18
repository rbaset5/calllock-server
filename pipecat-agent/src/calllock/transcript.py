def to_plain_text(log: list[dict]) -> str:
    """Convert transcript log to plain text format.

    Agent lines prefixed with "Agent:", user lines with "Caller:",
    tool invocations shown as "[Tool: name]".
    """
    if not log:
        return ""

    lines = []
    for entry in log:
        role = entry.get("role", "")
        if role == "agent":
            lines.append(f"Agent: {entry['content']}")
        elif role == "user":
            lines.append(f"Caller: {entry['content']}")
        elif role == "tool":
            lines.append(f"[Tool: {entry['name']}]")
    return "\n".join(lines)


def to_json_array(log: list[dict]) -> list[dict]:
    """Convert transcript log to structured JSON array for dashboard.

    Returns list of {role, content} dicts. Tool entries include name and result.
    """
    if not log:
        return []

    result = []
    for entry in log:
        role = entry.get("role", "")
        if role in ("agent", "user"):
            result.append({"role": role, "content": entry["content"]})
        elif role == "tool":
            result.append({
                "role": "tool",
                "name": entry["name"],
                "result": entry.get("result", {}),
            })
    return result


def to_timestamped_dump(
    log: list[dict],
    start_time: float,
    call_sid: str,
    phone: str,
    final_state: str,
) -> dict:
    """Build a timestamped transcript dump dict for structured logging.

    Timestamps are converted to relative seconds from call start.
    If start_time is 0, uses the first entry's timestamp as base.
    Entries missing a timestamp key are skipped.
    """
    base_time = start_time
    if base_time <= 0 and log:
        for entry in log:
            if "timestamp" in entry:
                base_time = entry["timestamp"]
                break

    entries = []
    for entry in log:
        if "timestamp" not in entry:
            continue
        e = {
            "t": round(entry["timestamp"] - base_time, 1),
            "role": entry["role"],
            "state": entry.get("state", ""),
        }
        if "content" in entry:
            e["content"] = entry["content"]
        if "name" in entry:
            e["name"] = entry["name"]
        if "result" in entry:
            e["result"] = entry["result"]
        entries.append(e)

    return {
        "call_sid": call_sid,
        "phone": phone,
        "final_state": final_state,
        "entries": entries,
    }
