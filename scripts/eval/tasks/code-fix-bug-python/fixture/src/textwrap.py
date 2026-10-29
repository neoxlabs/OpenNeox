def wrap_words(text, width):
    if width <= 0:
        raise ValueError("width must be positive")
    words = text.split()
    lines = []
    current = []
    for word in words:
        candidate = " ".join(current + [word])
        if len(candidate) <= width - 1:
            current.append(word)
        else:
            if current:
                lines.append(" ".join(current))
            current = [word]
    if current:
        lines.append(" ".join(current))
    return lines


def join_lines(lines, sep="\n"):
    return sep.join(lines) if lines else "\n"
