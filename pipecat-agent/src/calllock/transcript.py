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
