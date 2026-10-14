"""Count tokens exactly as Claude sees them, and compare formats and languages.

Companion to the Tokens lab. Uses the token counting endpoint, so no text is generated.

    python 01_count_tokens.py                  # compare formats and languages
    python 01_count_tokens.py notes.md app.py  # count your own files
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import make_client, model_argument, run
from data import PEOPLE

LANGUAGES = {
    "English": "Good morning, how are you today? I hope the weather is nice where you are.",
    "French": "Bonjour, comment allez-vous aujourd'hui ? J'espère qu'il fait beau chez vous.",
    "German": "Guten Morgen, wie geht es Ihnen heute? Ich hoffe, das Wetter ist schön bei Ihnen.",
    "Japanese": "おはようございます。今日はお元気ですか？そちらの天気が良いといいですね。",
    "Hindi": "सुप्रभात, आज आप कैसे हैं? मुझे आशा है कि आपके यहाँ मौसम अच्छा है।",
}


def formats() -> dict[str, str]:
    keys = list(PEOPLE[0])
    return {
        "JSON, pretty-printed": json.dumps(PEOPLE, indent=2),
        "JSON, minified": json.dumps(PEOPLE, separators=(",", ":")),
        "YAML": "\n".join("\n".join(f"{'- ' if i == 0 else '  '}{k}: {p[k]}" for i, k in enumerate(keys)) for p in PEOPLE),
        "CSV": "\n".join([",".join(keys)] + [",".join(str(p[k]) for k in keys) for p in PEOPLE]),
        "Markdown table": "\n".join([f"| {' | '.join(keys)} |", "|" + "---|" * len(keys)]
                                    + [f"| {' | '.join(str(p[k]) for k in keys)} |" for p in PEOPLE]),
        "Plain sentences": "\n".join(f"{p['name']} (id {p['id']}) is a {p['role'].lower()} in {p['city']} "
                                     f"who started in {p['start']}." for p in PEOPLE),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", type=Path, help="files to count")
    model_argument(parser)
    args = parser.parse_args()
    client = make_client()

    def count(text: str) -> int:
        return client.messages.count_tokens(model=args.model, messages=[{"role": "user", "content": text}]).input_tokens

    # Every count includes a few tokens of message framing; measure it once.
    framing = count(".") - 1
    print(f"Model: {args.model}. Each count below has about {framing} tokens of message framing removed.\n")

    if args.files:
        for path in args.files:
            text = path.read_text(encoding="utf-8", errors="replace")
            n = count(text) - framing
            print(f"{str(path):<40} {n:>9,} tokens   {len(text) / max(n, 1):.2f} characters per token")
        return

    rows = [(name, len(text), count(text) - framing) for name, text in formats().items()]
    cheapest = min(n for _, _, n in rows)
    print("Same six records, different formats")
    print(f"{'Format':<22}{'Characters':>12}{'Tokens':>9}{'vs cheapest':>13}")
    for name, chars, n in rows:
        print(f"{name:<22}{chars:>12,}{n:>9,}{n / cheapest:>12.2f}x")

    print("\nThe same sentence in different languages")
    print(f"{'Language':<12}{'Characters':>12}{'Tokens':>9}{'Chars per token':>17}")
    for lang, text in LANGUAGES.items():
        n = count(text) - framing
        print(f"{lang:<12}{len(text):>12,}{n:>9,}{len(text) / n:>17.2f}")


if __name__ == "__main__":
    run(main)
