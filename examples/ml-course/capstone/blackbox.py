"""The capstone's black boxes, the same five the /capstone page uses, with a query budget and a log.

Each box is an invented function of 2 to 6 inputs, every input scaled to [0, 1]; higher outputs are better. You
see only what you query. The definitions match frontend/src/pages/capstone/functions.ts number for number (the
seeded generator, the noise and the rounding), so a query here returns exactly what it returns on the page, and
test_capstone.py checks that against values computed by the TypeScript.

    from blackbox import Challenge
    ch = Challenge("oven")            # loads the starting points
    ch.query_round([[0.6, 0.4], [0.2, 0.8]])

Every query is appended to generated/ml-course/capstone/<id>.csv under the repo root, so your history survives a
restart and can go in your write-up. Delete the file to start again.
"""

import csv
import math
import pathlib
from dataclasses import dataclass, field

M32 = 0xFFFFFFFF
LOG_DIR = pathlib.Path(__file__).resolve().parents[3] / "generated" / "ml-course" / "capstone"


def _imul(a: int, b: int) -> int:
    """JavaScript's Math.imul, as an unsigned 32-bit result."""
    return ((a & M32) * (b & M32)) & M32


def mulberry32(seed: int):
    """The page's seeded generator: the same sequence of floats in [0, 1) as the TypeScript for the same seed."""
    state = seed & M32

    def rand() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & M32
        t = state
        t = _imul(t ^ (t >> 15), t | 1)
        t = (t ^ ((t + _imul(t ^ (t >> 7), t | 61)) & M32)) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296

    return rand


def gaussian(rand) -> float:
    """One standard normal draw by Box-Muller, taking u1 then u2 from `rand`, as the page does."""
    u1 = max(rand(), 1e-12)
    u2 = rand()
    return math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)


def tidy(x: list[float]) -> list[float]:
    """Clamp each input to [0, 1] and round to three decimals. JavaScript's Math.round rounds halves up, unlike
    Python's round(), so this uses floor(v + 0.5)."""
    return [math.floor(min(1.0, max(0.0, v)) * 1000 + 0.5) / 1000 for v in x]


@dataclass(frozen=True)
class Box:
    """One black box: its bumps (height, centre, width), noise, seed and budget."""

    id: str
    name: str
    inputs: tuple[str, ...]
    output: str
    bumps: tuple[tuple[float, tuple[float, ...], float], ...]
    noise_sd: float
    seed: int
    initial: int
    rounds: int
    per_round: int


BLACK_BOXES = {
    b.id: b
    for b in [
        Box("oven", "The bakery oven", ("temperature", "bake time"), "crust score",
            ((1.0, (0.62, 0.35), 0.12), (0.7, (0.18, 0.78), 0.08)), 0.01, 11, 4, 10, 2),
        Box("greenhouse", "The greenhouse", ("temperature", "humidity", "light hours"), "yield",
            ((1.0, (0.3, 0.7, 0.55), 0.15), (0.8, (0.75, 0.25, 0.4), 0.1), (0.5, (0.5, 0.5, 0.9), 0.07)),
            0.02, 23, 5, 10, 2),
        Box("coldbrew", "The cold brew recipe", ("grind", "water temperature", "steep time", "ratio"),
            "panel score", ((0.9, (0.2, 0.4, 0.8, 0.6), 0.18), (1.0, (0.7, 0.65, 0.3, 0.35), 0.09)),
            0.03, 37, 6, 10, 3),
        Box("concrete", "The concrete mix", ("cement", "water", "sand", "gravel", "curing time"), "strength",
            ((1.0, (0.55, 0.3, 0.6, 0.45, 0.8), 0.2), (0.75, (0.2, 0.7, 0.3, 0.8, 0.3), 0.15)), 0.02, 41, 7, 10, 3),
        Box("drone", "The drone controller",
            ("roll P", "roll D", "pitch P", "pitch D", "yaw P", "throttle filter"), "steadiness",
            ((1.0, (0.4, 0.6, 0.25, 0.7, 0.5, 0.35), 0.22), (0.85, (0.8, 0.2, 0.7, 0.3, 0.6, 0.75), 0.16),
             (0.6, (0.15, 0.15, 0.85, 0.5, 0.2, 0.6), 0.12)), 0.05, 53, 8, 10, 3),
    ]
}


def clean(box: Box, x: list[float]) -> float:
    """The function without noise: a sum of Gaussian bumps. Only for checking at the end; do not peek."""
    total = 0.0
    for h, c, w in box.bumps:
        d2 = sum((xi - ci) ** 2 for xi, ci in zip(x, c))
        total += h * math.exp(-d2 / (2 * w * w))
    return total


def measure(box: Box, x: list[float], query_index: int) -> float:
    """One reading: the clean value at the tidied point plus this query's fixed noise draw."""
    return clean(box, tidy(x)) + box.noise_sd * gaussian(mulberry32(box.seed * 1000 + query_index))


def starting_points(box: Box) -> list[list[float]]:
    """The points everyone gets before round 1, the same every time."""
    rand = mulberry32(box.seed)
    return [tidy([rand() for _ in box.inputs]) for _ in range(box.initial)]


@dataclass
class Challenge:
    """A budgeted run on one box. Rounds must be submitted whole, like on the page."""

    box_id: str
    log: pathlib.Path | None = None
    xs: list[list[float]] = field(default_factory=list)
    ys: list[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.box = BLACK_BOXES[self.box_id]
        self.log = self.log or LOG_DIR / f"{self.box_id}.csv"
        for i, x in enumerate(starting_points(self.box)):
            self.xs.append(x)
            self.ys.append(measure(self.box, x, i))
        self._replay()

    @property
    def rounds_done(self) -> int:
        return (len(self.xs) - self.box.initial) // self.box.per_round

    def query_round(self, points: list[list[float]]) -> list[float]:
        """Measure one round of points, log them, and return the readings."""
        b = self.box
        if self.rounds_done >= b.rounds:
            raise RuntimeError("All rounds are used.")
        if len(points) != b.per_round:
            raise ValueError(f"Each round takes {b.per_round} points.")
        for x in points:
            if len(x) != len(b.inputs) or any(not (0 <= v <= 1) for v in x):
                raise ValueError(f"Each point needs {len(b.inputs)} values between 0 and 1.")
        out = []
        for raw in points:
            x = tidy(raw)
            y = measure(b, x, len(self.xs))
            self.xs.append(x)
            self.ys.append(y)
            out.append(y)
        self._append(self.rounds_done, points=[self.xs[-k] for k in range(len(points), 0, -1)], ys=out)
        return out

    def best(self) -> tuple[list[float], float]:
        """The best measured point so far and its reading."""
        i = max(range(len(self.ys)), key=self.ys.__getitem__)
        return self.xs[i], self.ys[i]

    def _append(self, round_no: int, points: list[list[float]], ys: list[float]) -> None:
        self.log.parent.mkdir(parents=True, exist_ok=True)
        new = not self.log.exists()
        with self.log.open("a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["round", *self.box.inputs, self.box.output])
            for x, y in zip(points, ys):
                w.writerow([round_no, *x, f"{y:.6f}"])

    def _replay(self) -> None:
        """Re-measure the points in an existing log, so the outputs are always the box's, not the file's."""
        if not self.log.exists():
            return
        with self.log.open(newline="") as f:
            rows = list(csv.reader(f))[1:]
        points = [[float(v) for v in r[1 : 1 + len(self.box.inputs)]] for r in rows]
        if len(points) % self.box.per_round or len(points) > self.box.rounds * self.box.per_round:
            raise ValueError(f"{self.log} is not a whole number of rounds; fix or delete it.")
        for x in points:
            x = tidy(x)
            self.ys.append(measure(self.box, x, len(self.xs)))
            self.xs.append(x)
