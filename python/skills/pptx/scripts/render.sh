#!/usr/bin/env bash
# Renders a deck's slides to PNG so they can be checked by eye. Part of the pptx skill.
#
#   bash skills/pptx/scripts/render.sh work/quarterly-review-v2.pptx            # every slide
#   bash skills/pptx/scripts/render.sh work/quarterly-review-v2.pptx 3 5        # slides 3 to 5
#
# The deck is copied into outputs/ and the PNGs go to outputs/<deck name>-slide-01.png and so on, 960 pixels wide.
# The PDF goes to a temporary folder outside the project: a big deck makes a big PDF, and nobody needs it.
set -euo pipefail
deck="$1"; first="${2:-}"; last="${3:-$first}"
name="$(basename "${deck%.*}")"
mkdir -p work outputs
pdfdir="${TMPDIR:-/tmp}/render-pdf"; mkdir -p "$pdfdir"
# The deck you render is the deck the user gets: it goes into outputs/ too, unless it is there already.
[ "$(dirname "$deck")" = "outputs" ] || cp "$deck" outputs/
# LibreOffice keeps a profile in HOME and fails when another copy is still starting; a profile of its own avoids both.
soffice -env:UserInstallation=file://"${TMPDIR:-/tmp}"/lo-profile --headless --convert-to pdf --outdir "$pdfdir" "$deck" >/dev/null 2>&1 \
  || libreoffice -env:UserInstallation=file://"${TMPDIR:-/tmp}"/lo-profile --headless --convert-to pdf --outdir "$pdfdir" "$deck" >/dev/null
[ -n "$first" ] || rm -f outputs/"$name"-slide-*.png  # a full render replaces the old images; a partial one keeps the rest
pdftoppm -png -scale-to 960 ${first:+-f "$first"} ${last:+-l "$last"} "$pdfdir/$name.pdf" outputs/"$name"-slide
ls outputs/"$name"-slide-*.png
