"""Text that is read aloud: a normaliser that writes numbers and identifiers the way a person would say them, and a
chunker that cuts a streamed reply into pieces the voice can start on early.

A text to speech voice reads "4111 1111 1111 1111" as a number or guesses. A person reads a card number digit by
digit in groups, a phone number in the UK grouping, "£1.20" as "one pound twenty". This is done here, in code, before
synthesis, so every voice (Azure's and the local one) says the same thing and the rules can be tested.

normalise() writes plain words. explain() returns the same result as segments, so the page can show what changed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
        "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
SCALES = [(10**9, "billion"), (10**6, "million"), (10**3, "thousand")]
ORDINAL_WORDS = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
                 "nine": "ninth", "twelve": "twelfth"}
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]
MONTH_RE = "|".join(MONTHS)
MAX_TEXT = 4000


def number_words(n: int) -> str:
    """A whole number in British English: 1234 is "one thousand, two hundred and thirty-four"."""
    if n < 0:
        return "minus " + number_words(-n)
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + (f"-{ONES[n % 10]}" if n % 10 else "")
    if n < 1000:
        rest = n % 100
        return f"{ONES[n // 100]} hundred" + (f" and {number_words(rest)}" if rest else "")
    for size, name in SCALES:
        if n >= size:
            head, rest = divmod(n, size)
            tail = ""
            if rest:
                tail = (" and " if rest < 100 else ", ") + number_words(rest)
            return f"{number_words(head)} {name}{tail}"
    return str(n)  # beyond billions: left to the voice (not reached through the patterns below)


def ordinal_words(n: int) -> str:
    words = number_words(n)
    head, sep, last = words.rpartition("-" if "-" in words.split()[-1] else " ")
    word = last
    if word in ORDINAL_WORDS:
        word = ORDINAL_WORDS[word]
    elif word.endswith("y"):
        word = word[:-1] + "ieth"
    else:
        word += "th"
    return f"{head}{sep}{word}"


def digits_words(digits: str, zero: str = "zero") -> str:
    return " ".join(zero if d == "0" else ONES[int(d)] for d in digits if d.isdigit())


def group(digits: str, sizes: list[int]) -> list[str]:
    out, i = [], 0
    for size in sizes:
        if i >= len(digits):
            break
        out.append(digits[i:i + size])
        i += size
    if i < len(digits):
        out.append(digits[i:])
    return out


def chunk_digits(digits: str, size: int = 4) -> list[str]:
    """Groups of `size`; a last group of one digit borrows one from the group before it."""
    parts = [digits[i:i + size] for i in range(0, len(digits), size)]
    if len(parts) > 1 and len(parts[-1]) == 1 and len(parts[-2]) > 2:
        parts[-1] = parts[-2][-1] + parts[-1]
        parts[-2] = parts[-2][:-1]
    return parts


def year_words(y: int) -> str:
    if 2000 <= y <= 2009:
        return "two thousand" + (f" and {ONES[y - 2000]}" if y > 2000 else "")
    if 1000 <= y <= 9999:
        a, b = divmod(y, 100)
        if b == 0:
            return f"{number_words(a)} hundred"
        return f"{number_words(a)} {('oh ' + ONES[b]) if b < 10 else number_words(b)}"
    return number_words(y)


# ----------------------------------------------------------------------------------------------------- the readers

def read_card(m: re.Match) -> str:
    digits = re.sub(r"\D", "", m.group(0))
    return ", ".join(digits_words(g) for g in group(digits, [4] * 5))


def read_sort_code(m: re.Match) -> str:
    return ", ".join(digits_words(p) for p in re.split(r"[-\s]", m.group(0)))


def read_uk_phone(m: re.Match) -> str:
    raw = m.group(0)
    plus = raw.lstrip().startswith("+44") or raw.lstrip().startswith("0044")
    digits = re.sub(r"\D", "", raw)
    national = "0" + digits[4 if digits.startswith("0044") else 2:] if plus else digits
    if len(national) not in (10, 11):
        return digits_words(digits, "oh")
    if re.match(r"0(2[0-9])", national) and len(national) == 11:
        sizes = [3, 4, 4]
    elif re.match(r"0(800|808|845|843|844|870|871|300|301|302|303|333)", national) and len(national) == 11:
        sizes = [4, 3, 4]
    elif len(national) == 11:
        sizes = [5, 3, 3]
    else:
        sizes = [4, 3, 3]
    parts = group(national, sizes)
    if plus:
        parts[0] = parts[0][1:]
    words = [digits_words(p, "oh") for p in parts]
    return (("plus four four, " if plus else "") + ", ".join(words)).strip()


def read_expiry(m: re.Match) -> str:
    return f"{digits_words(m.group('m'), 'oh')}, {number_words(int(m.group('y')))}"


def read_postcode(m: re.Match) -> str:
    code = re.sub(r"\s", "", m.group(0)).upper()
    outward, inward = code[:-3], code[-3:]

    def spell(part: str) -> str:
        return " ".join(c if c.isalpha() else digits_words(c) for c in part)
    return f"{spell(outward)}, {spell(inward)}"


def read_reference(m: re.Match) -> str:
    out = []
    for token in m.group(0).split("-"):
        letters = re.findall(r"[A-Z]+|\d+", token)
        pieces = []
        for part in letters:
            if part.isalpha():
                pieces.append(" ".join(part))
            else:
                pieces.append(", ".join(digits_words(g) for g in chunk_digits(part, 4 if len(part) % 4 != 3 else 3)))
        out.append(" ".join(pieces))
    return ", ".join(out)


def read_long_digits(m: re.Match) -> str:
    digits = m.group("digits") if "digits" in m.groupdict() and m.group("digits") else m.group(0)
    size = 3 if len(digits) in (6, 9) else 4
    spoken = ", ".join(digits_words(g) for g in chunk_digits(digits, size))
    return (m.group("lead") + spoken) if "lead" in m.groupdict() and m.group("lead") is not None else spoken


def amount_words(text: str) -> str:
    """"1,234.5" as words, with the decimals read digit by digit."""
    whole, _, frac = text.replace(",", "").partition(".")
    out = number_words(int(whole or "0"))
    if frac:
        out += " point " + digits_words(frac)
    return out


def read_money(m: re.Match) -> str:
    symbol, body, suffix = m.group("sym"), m.group("amt"), (m.group("suf") or "").lower()
    major, minor = {"£": ("pound", "pence"), "$": ("dollar", "cents"), "€": ("euro", "cents")}[symbol]
    scale = {"k": "thousand", "m": "million", "bn": "billion", "b": "billion"}.get(suffix)
    if scale:
        n = float(body.replace(",", ""))
        words = amount_words(body)
        return f"{words} {scale} {major}s" if n != 1 else f"one {scale} {major}"
    whole, _, frac = body.replace(",", "").partition(".")
    pounds = int(whole or "0")
    pence = int((frac + "0")[:2]) if frac else 0
    parts = []
    if pounds or not pence:
        parts.append(f"{number_words(pounds)} {major}" + ("" if pounds == 1 else "s"))
    if pence:
        unit = "" if pounds and symbol == "£" else (" pence" if symbol == "£" else (" cent" if pence == 1 else " cents"))
        if symbol == "£" and not pounds:
            unit = " penny" if pence == 1 else " pence"
        parts.append(number_words(pence) + unit)
    return " ".join(parts)


def read_pence(m: re.Match) -> str:
    n = int(m.group("n"))
    return f"{number_words(n)} {'penny' if n == 1 else 'pence'}"


def read_percent(m: re.Match) -> str:
    return amount_words(m.group("n")) + " percent"


def time_words(hour: int, minute: int, suffix: str | None) -> str:
    if suffix:
        ampm = suffix.lower().replace(".", "")
        h = hour % 12 or 12
    else:
        ampm = "a m" if hour < 12 else "p m"
        h = hour % 12 or 12
    ampm = " ".join(ampm.replace(" ", ""))
    if minute == 0:
        return f"{number_words(h)} {ampm}"
    return f"{number_words(h)} {'oh ' + ONES[minute] if minute < 10 else number_words(minute)} {ampm}"


def read_time(m: re.Match) -> str:
    hour, minute = int(m.group("h")), int(m.group("m") or 0)
    if hour > 23 or minute > 59 or (m.group("ap") and hour > 12):
        return m.group(0)
    return time_words(hour, minute, m.group("ap"))


def valid_date(day: int, month: int) -> bool:
    return 1 <= day <= 31 and 1 <= month <= 12


def spoken_date(day: int, month: int, year: int | None) -> str:
    out = f"the {ordinal_words(day)} of {MONTHS[month - 1]}"
    return out + (f" {year_words(year)}" if year is not None else "")


def read_numeric_date(m: re.Match) -> str:
    if m.group("y4") is not None:  # 2025-03-15
        y, mo, d = int(m.group("y4")), int(m.group("m2")), int(m.group("d2"))
    else:  # UK order: 15/03/2025
        d, mo, y = int(m.group("d")), int(m.group("m")), int(m.group("y"))
        if y < 100:
            y += 2000
    return spoken_date(d, mo, y) if valid_date(d, mo) else m.group(0)


def read_named_date(m: re.Match) -> str:
    day, month = int(m.group("d")), MONTHS.index(m.group("mon").capitalize()) + 1
    year = int(m.group("y")) if m.group("y") else None
    return spoken_date(day, month, year) if 1 <= day <= 31 else m.group(0)


def read_month_first(m: re.Match) -> str:
    day, month = int(m.group("d")), MONTHS.index(m.group("mon").capitalize()) + 1
    year = int(m.group("y")) if m.group("y") else None
    return spoken_date(day, month, year) if 1 <= day <= 31 else m.group(0)


def read_year(m: re.Match) -> str:
    return m.group("lead") + year_words(int(m.group("y")))


def read_number(m: re.Match) -> str:
    text = m.group(0)
    if "." in text:
        return amount_words(text)
    return number_words(int(text.replace(",", "")))


def read_ordinal(m: re.Match) -> str:
    return ordinal_words(int(m.group("n")))


UNITS = {"km": "kilometres", "kg": "kilograms", "mph": "miles per hour", "cm": "centimetres", "mm": "millimetres",
         "gb": "gigabytes", "mb": "megabytes", "kb": "kilobytes", "ms": "milliseconds", "kwh": "kilowatt hours"}


def read_unit(m: re.Match) -> str:
    unit = UNITS[m.group("u").lower()]
    n = m.group("n")
    if n in ("1", "1.0") and unit.endswith("s"):
        unit = unit[:-1]
    return f"{amount_words(n)} {unit}"


@dataclass(frozen=True)
class Rule:
    kind: str
    pattern: re.Pattern
    read: Callable[[re.Match], str]


KEYWORD = r"(?:account|acc|card|reference|ref|order|number|no|invoice|policy|ticket|id|pin|code)"
RULES = [  # earlier rules win when two match the same place
    Rule("card number", re.compile(r"(?<![\d£$€.])\d{4}(?:[ -]?\d{4}){2}[ -]?\d{1,7}(?![\d])"), read_card),
    Rule("reference", re.compile(r"\b(?=[A-Z0-9]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z]{1,4}\d*(?:-[A-Z0-9]{2,})+\b"), read_reference),
    Rule("phone number", re.compile(r"(?<![\w.])(?:\+44[\s-]?\(?0?\)?[\s-]?\d{2,4}|0044[\s-]?\d{2,4}|0\d{2,4})(?:[\s-]?\d{3,4}){1,2}(?![\w])"), read_uk_phone),
    Rule("card expiry", re.compile(r"(?<![\d/])(?P<m>0[1-9]|1[0-2])/(?P<y>\d{2})(?![\d/])"), read_expiry),
    Rule("sort code", re.compile(r"(?<![\d-])\d{2}-\d{2}-\d{2}(?![\d-])"), read_sort_code),
    Rule("date", re.compile(r"\b(?P<y4>\d{4})-(?P<m2>\d{2})-(?P<d2>\d{2})\b|\b(?P<d>\d{1,2})[/.](?P<m>\d{1,2})[/.](?P<y>\d{4}|\d{2})\b"), read_numeric_date),
    # Case-sensitive: month names are capitalised, and "5 may be carried over" or "3 march past" are not dates.
    Rule("date", re.compile(rf"\b(?P<d>\d{{1,2}})(?:st|nd|rd|th)?(?: of)? (?P<mon>{MONTH_RE})(?:,? (?P<y>\d{{4}}))?\b"), read_named_date),
    Rule("date", re.compile(rf"\b(?P<mon>{MONTH_RE}) (?P<d>\d{{1,2}})(?:st|nd|rd|th)?(?:,? (?P<y>\d{{4}}))?\b"), read_month_first),
    Rule("postcode", re.compile(r"\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b"), read_postcode),
    Rule("money", re.compile(r"(?P<sym>[£$€])(?P<amt>\d[\d,]*(?:\.\d+)?)(?P<suf>bn|[kmb])?\b(?!\d)", re.I), read_money),
    Rule("money", re.compile(r"(?<![\w.£$€])(?P<n>\d{1,3})p\b"), read_pence),
    Rule("percentage", re.compile(r"(?P<n>\d[\d,]*(?:\.\d+)?)\s?%"), read_percent),
    Rule("time", re.compile(r"\b(?P<h>\d{1,2}):(?P<m>\d{2})(?:\s?(?P<ap>[ap]\.?m\.?))?(?!\d)|\b(?P<h2>\d{1,2})(?:\s?(?P<ap2>[ap]m))\b", re.I), None),  # replaced below
    Rule("identifier", re.compile(rf"(?P<lead>\b{KEYWORD}\.?:?\s?#?\s?)(?P<digits>\d{{4,}})\b", re.I), read_long_digits),
    Rule("identifier", re.compile(r"(?<![\d,.£$€])\d{5,}(?![\d,]|\.\d)"), read_long_digits),
    Rule("unit", re.compile(r"\b(?P<n>\d+(?:\.\d+)?)\s?(?P<u>km|kg|mph|cm|mm|gb|mb|kb|ms|kwh)\b", re.I), read_unit),
    Rule("ordinal", re.compile(r"\b(?P<n>\d{1,3})(?:st|nd|rd|th)\b"), read_ordinal),
    Rule("year", re.compile(r"(?P<lead>\b(?:in|since|until|by|during|year|from|before|after) )(?P<y>1[89]\d{2}|20\d{2})\b", re.I), read_year),
    Rule("number", re.compile(r"(?<![\d.])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d])|(?<![\d.,])\d+\.\d+(?!\d|\.\d)|(?<![\d.,])\d+(?![\d.,]\d)"), read_number),
]


def _read_time_either(m: re.Match) -> str:
    if m.group("h") is not None:
        return read_time(m)
    hour = int(m.group("h2"))
    if not 1 <= hour <= 12:
        return m.group(0)
    return time_words(hour, 0, m.group("ap2"))


RULES = [Rule(r.kind, r.pattern, _read_time_either) if r.kind == "time" else r for r in RULES]


@dataclass
class Segment:
    kind: str  # "text" for what is left alone
    before: str
    after: str


def explain(text: str) -> list[Segment]:
    """The text cut into pieces: what was changed (with its kind) and what was left as it was."""
    text = text[:MAX_TEXT]
    taken: list[tuple[int, int, int, str, str]] = []  # start, end, rule order, kind, spoken
    for order, rule in enumerate(RULES):
        for m in rule.pattern.finditer(text):
            try:
                spoken = rule.read(m)
            except (ValueError, KeyError, IndexError):
                continue
            start, end = m.start(), m.end()
            if "lead" in m.groupdict() and m.group("lead"):
                start += len(m.group("lead"))  # the keyword itself stays as written
                spoken = spoken[len(m.group("lead")):] if spoken.startswith(m.group("lead")) else spoken
            taken.append((start, end, order, rule.kind, spoken))
    taken.sort(key=lambda t: (t[0], t[2]))
    chosen: list[tuple[int, int, int, str, str]] = []
    for item in taken:
        if chosen and item[0] < chosen[-1][1]:
            continue  # overlaps one already chosen at this place
        chosen.append(item)
    segments: list[Segment] = []
    pos = 0
    for start, end, _order, kind, spoken in chosen:
        if start > pos:
            segments.append(Segment("text", text[pos:start], text[pos:start]))
        segments.append(Segment(kind, text[start:end], spoken))
        pos = end
    if pos < len(text):
        segments.append(Segment("text", text[pos:], text[pos:]))
    return segments


def normalise(text: str) -> str:
    """The text as it should be spoken."""
    return re.sub(r"[ \t]{2,}", " ", "".join(s.after for s in explain(text)))


# ---------------------------------------------------------------------------------------------------------- chunks

ABBREVIATIONS = {"mr", "mrs", "ms", "dr", "st", "no", "vs", "etc", "approx", "e.g", "i.e", "prof", "ltd", "inc", "jr", "sr"}
CLAUSE_MARKS = ",;:—–"
FIRST_CLAUSE_MIN = 24  # characters before the first comma is a good enough place to start speaking
SENTENCE_MIN = 6
LONG_PIECE = 180  # a piece with no punctuation this long is cut at a space


class Chunker:
    """Cuts streamed text into pieces to synthesise. The first piece ends at the first clause (a comma after enough
    words), so speech starts early; every later piece ends at a sentence. Full stops inside numbers, abbreviations and
    initials are not ends."""

    def __init__(self) -> None:
        self.buffer = ""
        self.count = 0

    def feed(self, delta: str) -> list[str]:
        self.buffer += delta
        return self._cut(final=False)

    def flush(self) -> list[str]:
        out = self._cut(final=True)
        rest = self.buffer.strip()
        self.buffer = ""
        if rest:
            out.append(rest)
            self.count += 1
        return out

    def _cut(self, final: bool) -> list[str]:
        out: list[str] = []
        while True:
            at = self._boundary(final)
            if at is None:
                return out
            piece, self.buffer = self.buffer[:at].strip(), self.buffer[at:]
            if piece:
                out.append(piece)
                self.count += 1

    def _boundary(self, final: bool) -> int | None:
        text = self.buffer
        for i, ch in enumerate(text):
            nxt = text[i + 1] if i + 1 < len(text) else ""
            if ch in ".!?…":
                if i + 1 >= len(text) and not final:
                    return None  # the next character decides: "3." then "5" is a number
                if nxt and not nxt.isspace() and nxt not in "\"')”":
                    continue
                word = re.findall(r"[\w.]+$", text[:i])
                last = (word[0] if word else "").lower()
                if ch == "." and (last in ABBREVIATIONS or (len(last) == 1 and last.isalpha())):
                    continue
                if i + 1 >= SENTENCE_MIN:
                    return i + 1
            elif ch in CLAUSE_MARKS and self.count == 0 and i >= FIRST_CLAUSE_MIN:
                if not nxt:
                    return None if not final else i + 1
                if nxt.isspace() and not (ch in ",:" and i and text[i - 1].isdigit() and text[i + 1:].lstrip()[:1].isdigit()):
                    return i + 1
        if len(text) > LONG_PIECE:
            cut = text.rfind(" ", 0, LONG_PIECE)
            if cut > 0:
                return cut
        return None
