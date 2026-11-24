"""Writes each week's exercise.py from its solution.py, so the two always share signatures and briefs.

A function marked with a `# EXERCISE` comment on the line above its `def` keeps its signature and docstring and
loses its body, which becomes `raise NotImplementedError`. Everything else (imports, data, helpers you are given)
is copied as it is. An existing exercise.py is left alone, because it may hold your work; pass --force to rewrite.

    python make_exercises.py            write the missing exercise files
    python make_exercises.py --force    rewrite all of them (your answers are lost)
"""

import ast
import pathlib
import sys

ROOT = pathlib.Path(__file__).parent
HEADER = '# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.\n'


def strip(source: str) -> str:
    """Returns the source with every marked function's body replaced by a TODO."""
    lines = source.splitlines(keepends=True)
    tree = ast.parse(source)
    cuts = []  # (first line to drop, last line to drop, indent, name), 1-based and inclusive
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef):
            continue
        marker_line = node.lineno - 2 - len(node.decorator_list)
        if marker_line < 0 or lines[marker_line].strip() != "# EXERCISE":
            continue
        body = node.body
        has_doc = isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant)
        first = body[1].lineno if has_doc and len(body) > 1 else (None if has_doc else body[0].lineno)
        if first is None:
            continue
        # Comments above the first statement belong to the solution's reasoning, so drop them too.
        start = (body[0].end_lineno + 1) if has_doc else first
        indent = " " * body[-1].col_offset
        cuts.append((start, node.end_lineno, indent, node.name))
    for start, end, indent, name in reversed(cuts):
        lines[start - 1 : end] = [f'{indent}raise NotImplementedError("TODO: write {name}")\n']
    return HEADER + "".join(lines)


def main() -> None:
    force = "--force" in sys.argv
    for solution in sorted(ROOT.glob("week*/solution.py")):
        target = solution.with_name("exercise.py")
        if target.exists() and not force:
            continue
        target.write_text(strip(solution.read_text()))
        print("wrote", target.relative_to(ROOT))


if __name__ == "__main__":
    main()
