"""Sample media for the Content Understanding and vision lab, made on this machine.

Documents are drawn with Pillow. Photos are generated once with gpt-image-2 and cached in generated/ (ignored by
git). The video is put together from those photos with ffmpeg, with narration from macOS `say` when it is there,
so Content Understanding has speech to transcribe. Nothing here is a real person, company or claim.
"""
from __future__ import annotations

import io
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

from .guardrail_samples import _font

DOCUMENTS = {
    "invoice": "Invoice with a line-item table (its subtotal is £9 short of its lines)",
    "claim": "Home insurance claim form, filled in",
}
PHOTOS = {  # name: (label, prompt)
    "ceiling": ("Water-damaged kitchen ceiling", "A realistic photo of a kitchen ceiling with a large brown water stain and "
                "peeling paint above a white cupboard, a small crack near the light fitting, daylight, taken on a phone"),
    "shelf": ("Shop shelf with a promotion sign", "A realistic photo of a supermarket shelf of breakfast cereals in "
              "plain unbranded boxes, a yellow price label reading 2 for £5 and a red sign reading SALE, one empty gap"),
    "street": ("Street scene", "A realistic photo of a quiet UK residential street: a white delivery van parked on the "
               "left, a cyclist in a yellow jacket in the middle, a red post box on the right pavement, overcast day"),
}
NARRATION = ("This is the claim video for the kitchen leak at 14 Harbour Road. First, the kitchen ceiling: the stain is "
             "about a metre across and the paint is peeling. Next, the shop where the replacement paint was bought. "
             "Finally, the street outside, where the plumber's van is parked.")


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def invoice() -> bytes:
    """An A4-shaped invoice. The lines add up to £409.00 before VAT, but the subtotal says £400.00."""
    img = Image.new("RGB", (1240, 1754), "white")
    d = ImageDraw.Draw(img)
    big, mid, small = _font(46), _font(28), _font(24)
    d.text((80, 80), "Kestrel Decorating Supplies", font=big, fill=(20, 40, 80))
    d.text((80, 150), "12 Quay Street, Harbourside HB1 4QT · VAT reg GB 123 4567 89", font=small, fill=(80, 80, 80))
    d.text((860, 80), "INVOICE", font=big, fill=(20, 40, 80))
    for i, (k, v) in enumerate([("Invoice no.", "KD-20419"), ("Date", "28 October 2026"), ("Due", "27 November 2026")]):
        d.text((820, 160 + i * 40), k, font=small, fill=(90, 90, 90))
        d.text((1000, 160 + i * 40), v, font=small, fill=(20, 20, 20))
    d.text((80, 300), "Bill to", font=mid, fill=(20, 40, 80))
    for i, line in enumerate(["Ms Priya Nair", "14 Harbour Road", "Harbourside HB2 7LP"]):
        d.text((80, 345 + i * 36), line, font=small, fill=(20, 20, 20))
    cols = [80, 620, 800, 980]
    y = 520
    d.rectangle([70, y - 10, 1170, y + 40], fill=(232, 238, 246))
    for x, h in zip(cols, ["Description", "Qty", "Unit price", "Amount"]):
        d.text((x, y), h, font=mid, fill=(20, 40, 80))
    lines = [("Stain-block primer, 2.5 l", 2, 24.50), ("Ceiling paint, matt white, 5 l", 3, 32.00),
             ("Plaster repair kit", 1, 18.00), ("Labour: ceiling repair, per hour", 6, 38.00), ("Dust sheets", 4, 4.50)]
    for i, (desc, qty, unit) in enumerate(lines):
        yy = y + 70 + i * 56
        for x, val in zip(cols, [desc, str(qty), f"£{unit:.2f}", f"£{qty * unit:.2f}"]):
            d.text((x, yy), val, font=small, fill=(20, 20, 20))
        d.line([70, yy + 42, 1170, yy + 42], fill=(225, 225, 225))
    yy = y + 70 + len(lines) * 56 + 30
    for i, (k, v) in enumerate([("Subtotal", "£400.00"), ("VAT at 20%", "£80.00"), ("Total due", "£480.00")]):
        d.text((800, yy + i * 46), k, font=mid if i == 2 else small, fill=(20, 20, 20))
        d.text((980, yy + i * 46), v, font=mid if i == 2 else small, fill=(20, 20, 20))
    d.text((80, 1600), "Pay by bank transfer: sort code 04-00-04, account 12345678, reference KD-20419.", font=small, fill=(80, 80, 80))
    return _png(img)


def claim_form() -> bytes:
    """A home insurance claim form with typed answers and ticked boxes."""
    img = Image.new("RGB", (1240, 1754), "white")
    d = ImageDraw.Draw(img)
    big, mid, small = _font(44), _font(28), _font(25)
    d.rectangle([0, 0, 1240, 130], fill=(30, 90, 80))
    d.text((70, 40), "Harbour Mutual · Home insurance claim", font=big, fill="white")
    fields = [("Policy number", "HM-HOME-558120"), ("Policyholder", "Priya Nair"), ("Address", "14 Harbour Road, Harbourside HB2 7LP"),
              ("Phone", "07700 900417"), ("Date of incident", "21/10/2026"), ("Discovered", "22/10/2026, about 7am")]
    y = 180
    for k, v in fields:
        d.text((70, y), k, font=small, fill=(90, 90, 90))
        d.rectangle([380, y - 6, 1170, y + 36], outline=(170, 170, 170))
        d.text((392, y), v, font=small, fill=(10, 10, 90))
        y += 70
    d.text((70, y + 10), "Type of damage (tick one)", font=mid, fill=(30, 90, 80))
    y += 60
    for i, option in enumerate(["Escape of water", "Fire or smoke", "Storm", "Theft", "Accidental damage"]):
        x = 70 + (i % 3) * 370
        yy = y + (i // 3) * 50
        d.rectangle([x, yy, x + 28, yy + 28], outline=(60, 60, 60), width=2)
        if i == 0:
            d.line([x + 5, yy + 14, x + 12, yy + 22, x + 24, yy + 5], fill=(10, 10, 90), width=4)
        d.text((x + 42, yy - 2), option, font=small, fill=(20, 20, 20))
    y += 130
    d.text((70, y), "What happened", font=mid, fill=(30, 90, 80))
    story = ["The flat upstairs had a leaking washing machine hose overnight. Water came through the kitchen",
             "ceiling and left a brown stain about one metre across, with peeling paint and a small crack",
             "by the light. We turned the electrics off in the kitchen. The upstairs neighbour has fixed the",
             "hose. A decorator has quoted £480 including VAT to repair and repaint the ceiling."]
    for i, line in enumerate(story):
        d.text((70, y + 50 + i * 40), line, font=small, fill=(10, 10, 90))
    y += 250
    d.text((70, y), "Amount claimed", font=small, fill=(90, 90, 90))
    d.rectangle([380, y - 6, 700, y + 36], outline=(170, 170, 170))
    d.text((392, y), "£480.00", font=small, fill=(10, 10, 90))
    d.text((70, y + 90), "I confirm the information above is true.  Signed: P. Nair      Date: 23/10/2026", font=small, fill=(20, 20, 20))
    return _png(img)


DOCUMENT_MAKERS = {"invoice": invoice, "claim": claim_form}


def make_video(photos: list[Path], out: Path) -> bool:
    """Three photos, four seconds each, with the narration as the soundtrack when `say` is available."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    with tempfile.TemporaryDirectory() as tmp:
        audio = Path(tmp) / "narration.aiff"
        has_audio = bool(shutil.which("say")) and subprocess.run(
            ["say", "-v", "Daniel", "-o", str(audio), NARRATION], capture_output=True).returncode == 0
        inputs: list[str] = []
        for p in photos:
            inputs += ["-loop", "1", "-t", "5", "-i", str(p)]
        if has_audio:
            inputs += ["-i", str(audio)]
        n = len(photos)
        chain = "".join(f"[{i}:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=25[v{i}];"
                        for i in range(n))
        chain += "".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[v]"
        cmd = [ffmpeg, "-y", *inputs, "-filter_complex", chain, "-map", "[v]"]
        if has_audio:
            cmd += ["-map", f"{n}:a", "-c:a", "aac", "-shortest"]
        cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]
        return subprocess.run(cmd, capture_output=True).returncode == 0


def make_audio(out: Path) -> bool:
    """The narration alone, as a 16 kHz WAV, for the audio analyzer."""
    if not (shutil.which("say") and shutil.which("ffmpeg")):
        return False
    with tempfile.TemporaryDirectory() as tmp:
        aiff = Path(tmp) / "n.aiff"
        if subprocess.run(["say", "-v", "Daniel", "-o", str(aiff), NARRATION], capture_output=True).returncode:
            return False
        return subprocess.run(["ffmpeg", "-y", "-i", str(aiff), "-ar", "16000", "-ac", "1", str(out)],
                              capture_output=True).returncode == 0
