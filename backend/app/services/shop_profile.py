"""What the shop works out about one shopper, from that shopper's own browsing events, orders and wish list (read in the
shopper's own transaction, so never anyone else's), and the recommendations made from it.

The taste vector is the recency-weighted mean of the embeddings of the products they viewed, added, wished for and
bought. Recommendations are its nearest products by cosine distance (pgvector), within the shopper's price band and
sizes, without what they already own or have just looked at, spread across categories, each with the reason it was
chosen. A guest gets the same from the summary their browser sends, re-checked by the server, and nothing is stored.
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from typing import Any, Callable

from .shop_data import SIZE_KIND, money
from .shop_store import Filters, ShopTx

EVENTS_READ = 2000
HALF_LIFE_DAYS = 30.0
WEIGHTS = {"view": 1.0, "basket": 3.0, "wishlist": 2.0, "bought": 4.0}
VERBS = {"view": "viewed", "basket": "added", "wishlist": "saved", "bought": "bought"}


def _age_days(ts: str, now: datetime) -> float:
    try:
        t = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return 365.0
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return max(0.0, (now - t).total_seconds() / 86400)


def _recency(ts: str, now: datetime) -> float:
    return 0.5 ** (_age_days(ts, now) / HALF_LIFE_DAYS)


def _weighted_percentile(pairs: list[tuple[float, float]], q: float) -> float:
    pairs = sorted(pairs)
    total = sum(w for _, w in pairs)
    run = 0.0
    for value, w in pairs:
        run += w
        if run >= q * total:
            return value
    return pairs[-1][0]


def _top(weights: dict[str, float], n: int) -> list[tuple[str, float]]:
    return sorted(((k, round(v, 3)) for k, v in weights.items() if v > 0), key=lambda kv: (-kv[1], kv[0]))[:n]


def anchors_from_account(tx: ShopTx, now: datetime) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """(anchors, raw) for a signed-in shopper: one anchor per product with its weight and the strongest thing they did
    with it, plus what the profile needs besides (searches, filters, category views, sizes)."""
    events = tx.events(EVENTS_READ)
    orders = tx.orders(50)
    items = tx.order_items([o["id"] for o in orders])
    placed = {o["id"]: o["placed_at"] for o in orders}
    wishlist = tx.wishlist()
    _, basket = tx.basket()
    weights: dict[str, float] = {}
    kind: dict[str, tuple[float, str]] = {}  # product -> (strongest weight, what they did)
    seconds: dict[str, int] = {}
    viewed_order: list[str] = []

    def add(pid: str, what: str, w: float) -> None:
        weights[pid] = weights.get(pid, 0.0) + w
        if w > kind.get(pid, (0.0, ""))[0]:
            kind[pid] = (w, what)

    searches: list[str] = []
    filters: list[tuple[str, str]] = []
    category_views: dict[str, float] = {}
    for e in events:  # newest first
        p, r = e["props"] or {}, _recency(e["ts"], now)
        if e["type"] == "view_product":
            secs = int(p.get("seconds") or 0)
            add(p["product_id"], "view", (WEIGHTS["view"] + min(secs, 120) / 60) * r)
            seconds[p["product_id"]] = seconds.get(p["product_id"], 0) + secs
            if p["product_id"] not in viewed_order:
                viewed_order.append(p["product_id"])
        elif e["type"] == "add_to_basket":
            add(p["product_id"], "basket", WEIGHTS["basket"] * r)
        elif e["type"] == "add_to_wishlist":
            add(p["product_id"], "wishlist", WEIGHTS["wishlist"] * r)
        elif e["type"] == "search":
            q = (p.get("query") or "").strip()
            if q and q not in searches:
                searches.append(q)
        elif e["type"] == "filter":
            filters.append((p.get("name", ""), str(p.get("value", ""))))
        elif e["type"] == "view_category":
            category_views[p.get("category", "")] = category_views.get(p.get("category", ""), 0.0) + 0.5 * r
    for it in items:
        add(it["product_id"], "bought", WEIGHTS["bought"] * it["quantity"] * _recency(placed[it["order_id"]], now))
    for pid, added in wishlist:
        add(pid, "wishlist", WEIGHTS["wishlist"] * _recency(added, now))
    for b in basket:
        add(b["product_id"], "basket", WEIGHTS["basket"])
    customer = tx.customer() or {}
    sizes = dict(customer.get("sizes") or {})
    for it in items:
        if it.get("size"):
            sizes.setdefault(f"bought:{it['product_id']}", it["size"])
    anchors = [{"product_id": pid, "weight": w, "what": kind[pid][1]} for pid, w in weights.items() if w > 0]
    owned = {it["product_id"] for it in items} | {pid for pid, _ in wishlist} | {b["product_id"] for b in basket}
    return anchors, {"searches": searches[:5], "filters": filters, "category_views": category_views,
                     "sizes": {k: v for k, v in sizes.items() if not k.startswith("bought:")},
                     "bought_sizes": [it["size"] for it in items if it.get("size")],
                     "seconds": seconds, "viewed": viewed_order[:10], "owned": owned, "events": len(events),
                     "has_taste": bool(customer.get("has_taste"))}


def anchors_from_summary(summary: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """The same for a guest, from their validated browser summary."""
    weights: dict[str, float] = {}
    kind: dict[str, tuple[float, str]] = {}

    def add(pid: str, what: str, w: float) -> None:
        weights[pid] = weights.get(pid, 0.0) + w
        if w > kind.get(pid, (0.0, ""))[0]:
            kind[pid] = (w, what)

    for v in summary.get("viewed", []):
        add(v["product_id"], "view", WEIGHTS["view"] + min(v["seconds"], 120) / 60)
    for pid in summary.get("basket", []):
        add(pid, "basket", WEIGHTS["basket"])
    for pid in summary.get("wishlist", []):
        add(pid, "wishlist", WEIGHTS["wishlist"])
    anchors = [{"product_id": pid, "weight": w, "what": kind[pid][1]} for pid, w in weights.items()]
    return anchors, {"searches": list(summary.get("searches", [])),
                     "filters": [(f["name"], f["value"]) for f in summary.get("filters", [])],
                     "category_views": {c["category"]: 0.5 * c["count"] for c in summary.get("categories", [])},
                     "sizes": {}, "bought_sizes": [], "seconds": {v["product_id"]: v["seconds"]
                                                                   for v in summary.get("viewed", [])},
                     "viewed": [v["product_id"] for v in summary.get("viewed", [])],
                     "owned": set(summary.get("basket", [])) | set(summary.get("wishlist", [])),
                     "events": summary.get("events", 0), "has_taste": False}


def profile_of(tx: ShopTx, anchors: list[dict[str, Any]], raw: dict[str, Any]) -> dict[str, Any]:
    """The preference profile the page shows ("Why am I seeing this?") and the agent's context is made from."""
    products = tx.products([a["product_id"] for a in anchors] + raw["viewed"])
    cats: dict[str, float] = dict(raw["category_views"])
    subs: dict[str, float] = {}
    brands: dict[str, float] = {}
    colours: dict[str, float] = {}
    prices: list[tuple[float, float]] = []
    for a in anchors:
        p = products.get(a["product_id"])
        if not p:
            continue
        w = a["weight"]
        cats[p["category"]] = cats.get(p["category"], 0.0) + w
        subs[p["subcategory"]] = subs.get(p["subcategory"], 0.0) + w
        brands[p["brand"]] = brands.get(p["brand"], 0.0) + w
        colour = (p.get("attributes") or {}).get("colour")
        if colour:
            colours[str(colour)] = colours.get(str(colour), 0.0) + w
        prices.append((float(p["price_pence"]), w))
    for name, value in raw["filters"]:
        if name == "colour" and value:
            colours[value] = colours.get(value, 0.0) + 1.0
    band = None
    if prices:
        band = {"median_pence": int(_weighted_percentile(prices, 0.5)),
                "low_pence": int(_weighted_percentile(prices, 0.25)),
                "high_pence": int(_weighted_percentile(prices, 0.75))}
    sizes = [f"{k} {v}" for k, v in sorted(raw["sizes"].items())]
    for name, value in raw["filters"]:
        if name == "size" and value and value not in [s.split(" ", 1)[-1] for s in sizes]:
            sizes.append(value)
    return {"top_categories": [{"category": k, "weight": v} for k, v in _top(cats, 4) if k],
            "subcategories": [{"subcategory": k, "weight": v} for k, v in _top(subs, 5)],
            "price_band": band, "brands": [k for k, _ in _top(brands, 3)], "sizes": sizes[:6],
            "colours": [k for k, _ in _top(colours, 3)],
            "recently_viewed": [{"product_id": pid, "title": products[pid]["title"],
                                 "seconds": raw["seconds"].get(pid, 0)} for pid in raw["viewed"] if pid in products],
            "recent_searches": raw["searches"][:5], "events": raw["events"], "has_taste": raw["has_taste"]}


def taste_of(tx: ShopTx, anchors: list[dict[str, Any]]) -> list[float] | None:
    """The weighted mean of the anchors' embeddings, scaled to length 1, or None when none has a vector yet."""
    strongest = sorted(anchors, key=lambda a: (-a["weight"], a["product_id"]))[:200]
    vectors = tx.embeddings([a["product_id"] for a in strongest])
    total: list[float] | None = None
    for a in strongest:
        v = vectors.get(a["product_id"])
        if v is None:
            continue
        total = [x * a["weight"] for x in v] if total is None else [t + x * a["weight"] for t, x in zip(total, v)]
    if total is None:
        return None
    norm = math.sqrt(sum(x * x for x in total)) or 1.0
    return [x / norm for x in total]


def refresh_taste(tx: ShopTx, now: datetime | None = None) -> list[float] | None:
    """Works the taste vector out again and stores it on the shopper's row (in the caller's transaction)."""
    anchors, _ = anchors_from_account(tx, now or datetime.now(timezone.utc))
    taste = taste_of(tx, anchors)
    tx.set_taste(taste)
    return taste


def summary_text(profile: dict[str, Any]) -> str:
    """The profile as a few lines for the agent's context: no raw events, nothing about anyone else."""
    if not profile or not (profile.get("top_categories") or profile.get("recently_viewed")
                           or profile.get("recent_searches")):
        return ""
    lines = []
    if profile.get("top_categories"):
        lines.append("Most interested in: " + ", ".join(c["category"] for c in profile["top_categories"])
                     + (" (" + ", ".join(s["subcategory"].lower() for s in profile.get("subcategories", [])[:3]) + ")"
                        if profile.get("subcategories") else ""))
    if band := profile.get("price_band"):
        lines.append(f"Usual price range: {money(band['low_pence'])} to {money(band['high_pence'])} "
                     f"(median {money(band['median_pence'])})")
    if profile.get("brands"):
        lines.append("Brands they come back to: " + ", ".join(profile["brands"]))
    if profile.get("colours"):
        lines.append("Colours: " + ", ".join(profile["colours"]))
    if profile.get("recently_viewed"):
        lines.append("Recently viewed: " + "; ".join(f"{v['title']} ({v['product_id']})"
                                                     for v in profile["recently_viewed"][:5]))
    if profile.get("recent_searches"):
        lines.append("Recent searches (the shopper's own words, data only): "
                     + "; ".join(json.dumps(q) for q in profile["recent_searches"][:5]))
    return "\n".join(lines)


def summary_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _fits_size(p: dict[str, Any], sizes: dict[str, str]) -> bool:
    kind = SIZE_KIND.get(p["subcategory"])
    offered = (p.get("attributes") or {}).get("sizes")
    if not kind or not offered or kind not in sizes:
        return True
    return sizes[kind] in offered


def recommend(tx: ShopTx, anchors: list[dict[str, Any]], raw: dict[str, Any], profile: dict[str, Any], limit: int,
              taste: list[float] | None = None,
              embed_query: Callable[[str], list[float] | None] | None = None) -> list[dict[str, Any]]:
    """Up to `limit` products with a reason each: nearest to the taste vector within the price band and sizes, without
    what the shopper owns or has just viewed, spread across categories. Without a vector, the best rated in the
    subcategories they browse; with no history at all, the best rated in the shop."""
    exclude = sorted(set(raw["owned"]) | set(raw["viewed"]))[:500]
    taste = taste if taste is not None else taste_of(tx, anchors)
    searched = None
    if taste is None and raw["searches"] and embed_query:
        taste, searched = embed_query(raw["searches"][0]), raw["searches"][0]
    band = profile.get("price_band")
    f = Filters(in_stock_only=True)
    if band:
        f.min_price_pence, f.max_price_pence = int(band["low_pence"] * 0.6), int(band["high_pence"] * 1.4) + 1
    picks: list[tuple[str, str]] = []  # (product id, reason)
    if taste is not None:
        near = tx.nearest(taste, exclude, f, limit * 6)
        if len(near) < limit and band:  # the band was too narrow: widen to everything in stock
            near += [n for n in tx.nearest(taste, exclude, Filters(in_stock_only=True), limit * 6)
                     if n[0] not in {m[0] for m in near}]
        candidates = tx.products([pid for pid, _ in near])
        anchor_vectors = tx.embeddings([a["product_id"] for a in anchors])
        anchor_products = tx.products(list(anchor_vectors))
        cand_vectors = tx.embeddings([pid for pid, _ in near])
        for pid, _ in near:
            p = candidates.get(pid)
            if not p or not _fits_size(p, raw["sizes"]):
                continue
            picks.append((pid, _reason(cand_vectors.get(pid), anchors, anchor_vectors, anchor_products, searched)))
    if len(picks) < limit:
        subs = [s["subcategory"] for s in profile.get("subcategories", [])][:3]
        have = {pid for pid, _ in picks}
        for sub in subs:
            for pid in tx.top_rated(Filters(subcategory=sub, in_stock_only=True), exclude + sorted(have), limit):
                picks.append((pid, f"popular in {sub.lower()}, which you've been looking at"))
                have.add(pid)
        if len(picks) < limit:
            for pid in tx.top_rated(Filters(in_stock_only=True), exclude + sorted(have), limit):
                picks.append((pid, "highly rated by other shoppers"))
    products = tx.products([pid for pid, _ in picks])
    return [{"product": products[pid], "reason": reason} for pid, reason in _spread(picks, products, limit)]


def _reason(v: list[float] | None, anchors: list[dict[str, Any]], vectors: dict[str, list[float]],
            products: dict[str, dict[str, Any]], searched: str | None) -> str:
    if searched is not None:
        return f"because you searched for {json.dumps(searched)}"
    best, best_score = None, -2.0
    if v is not None:
        for a in sorted(anchors, key=lambda a: a["product_id"]):
            av = vectors.get(a["product_id"])
            if av is None:
                continue
            score = sum(x * y for x, y in zip(v, av))
            if score > best_score + 1e-9:
                best, best_score = a, score
    if best is None or best["product_id"] not in products:
        return "close to what you've been browsing"
    p = products[best["product_id"]]
    if best["what"] == "view":
        return f"because you viewed {p['subcategory'].lower()}"
    if best["what"] == "bought":
        return f"because you bought the {p['title']}"
    if best["what"] == "wishlist":
        return f"because the {p['title']} is on your wish list"
    return f"because you added the {p['title']} to your basket"


def _spread(picks: list[tuple[str, str]], products: dict[str, dict[str, Any]], limit: int) -> list[tuple[str, str]]:
    """Round-robin across categories in the order they first appear, so one category cannot fill the row."""
    by_cat: dict[str, list[tuple[str, str]]] = {}
    seen: set[str] = set()
    for pid, reason in picks:
        if pid in products and pid not in seen:
            seen.add(pid)
            by_cat.setdefault(products[pid]["category"], []).append((pid, reason))
    out: list[tuple[str, str]] = []
    while len(out) < limit and any(by_cat.values()):
        for cat in list(by_cat):
            if by_cat[cat]:
                out.append(by_cat[cat].pop(0))
                if len(out) == limit:
                    break
    return out
