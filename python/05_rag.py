"""Retrieval-augmented generation: find relevant handbook passages, then answer from them.

Companion to the Embeddings & RAG lab. Uses the same embedding model as the
browser lab (all-MiniLM-L6-v2) through fastembed, plus BM25 keyword search.
If no passage clears the similarity threshold, the script answers "not found"
without calling Claude at all.

    python 05_rag.py "How many vacation days do I get?"
    python 05_rag.py "Who do I call on extension 4400?" --method hybrid
    python 05_rag.py "Can I work from Spain for a month?" --chunking fixed --retrieve-only
"""
from __future__ import annotations

import argparse
import math
import re
from collections import Counter

import numpy as np

from common import create, describe_usage, ensure_answered, make_client, model_argument, run, text_of
from data import HANDBOOK_SECTIONS


def chunk(mode: str, size: int, overlap: int) -> list[dict]:
    if mode == "section":
        return [{"source": f"handbook: {title}", "text": f"{title}. {body}"} for title, body in HANDBOOK_SECTIONS]
    words = " ".join(f"{t}. {b}" for t, b in HANDBOOK_SECTIONS).split()
    step = max(1, size - size * overlap // 100)
    chunks = []
    for start in range(0, len(words), step):
        chunks.append({"source": f"handbook: words {start + 1}-{min(start + size, len(words))}",
                       "text": " ".join(words[start:start + size])})
        if start + size >= len(words):
            break
    return chunks


STOPWORDS = set("""a an the and or but if of to in on at for from by with into about as is are was were be been
do does did i me my we our you your he she it its they them their this that these those what which who whom
how when where why can could would should will shall may might must have has had not no get got""".split())


def tokenize(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9£']+", text.lower()) if w not in STOPWORDS]


def bm25(query: str, docs: list[str], k1: float = 1.2, b: float = 0.75) -> list[float]:
    tokenized = [tokenize(d) for d in docs]
    avg = sum(map(len, tokenized)) / len(tokenized)
    df = Counter(term for doc in tokenized for term in set(doc))
    n = len(docs)
    scores = []
    for doc in tokenized:
        tf = Counter(doc)
        s = 0.0
        for term in tokenize(query):
            if term in tf:
                idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
                s += idf * tf[term] * (k1 + 1) / (tf[term] + k1 * (1 - b + b * len(doc) / avg))
        scores.append(s)
    return scores


def ranks(scores: list[float]) -> list[int]:
    order = sorted(range(len(scores)), key=lambda i: -scores[i])
    r = [0] * len(scores)
    for position, i in enumerate(order, 1):
        r[i] = position
    return r


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("question")
    parser.add_argument("--chunking", choices=["section", "fixed"], default="section")
    parser.add_argument("--chunk-words", type=int, default=60)
    parser.add_argument("--overlap", type=int, default=15, help="overlap between fixed chunks, in percent")
    parser.add_argument("--method", choices=["embeddings", "bm25", "hybrid"], default="hybrid")
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument("--min-score", type=float, default=0.3, help="minimum embedding similarity")
    parser.add_argument("--min-keyword", type=float, default=1.5, help="minimum BM25 score that counts as evidence")
    parser.add_argument("--retrieve-only", action="store_true", help="show retrieval without calling Claude")
    model_argument(parser)
    args = parser.parse_args()

    from fastembed import TextEmbedding  # imported here so --help works without it

    chunks = chunk(args.chunking, args.chunk_words, args.overlap)
    texts = [c["text"] for c in chunks]
    embedder = TextEmbedding(model_name="sentence-transformers/all-MiniLM-L6-v2")
    vectors = np.array(list(embedder.embed(texts)))
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    query = np.array(list(embedder.embed([args.question])))[0]
    query /= np.linalg.norm(query)
    cosine = (vectors @ query).tolist()
    keyword = bm25(args.question, texts)
    rank_e, rank_k = ranks(cosine), ranks(keyword)

    if args.method == "embeddings":
        score = cosine
    elif args.method == "bm25":
        score = keyword
    else:  # reciprocal rank fusion
        score = [1 / (60 + rank_e[i]) + 1 / (60 + rank_k[i]) for i in range(len(chunks))]
    order = sorted(range(len(chunks)), key=lambda i: -score[i])

    # A chunk is usable when it is in the top k and has real evidence:
    # enough meaning similarity, or a strong keyword match.
    picked = [i for i in order[:args.top_k] if cosine[i] >= args.min_score or keyword[i] >= args.min_keyword]

    print(f"{len(chunks)} chunks ({args.chunking}), method {args.method}, "
          f"evidence needed: meaning >= {args.min_score} or keyword >= {args.min_keyword}\n")
    print(f"{'#':>2} {'meaning':>8} {'keyword':>8}  chunk")
    for position, i in enumerate(order[:8], 1):
        mark = "*" if i in picked else " "
        print(f"{position:>2}{mark}{cosine[i]:>8.2f} {keyword[i]:>8.2f}  {texts[i][:70]}")
    print("\n* = sent to the model")

    if not picked:
        print("\nNo passage cleared the threshold, so Claude is not called.")
        print("Answer: I couldn't find that in the handbook.")
        return
    if args.retrieve_only:
        return

    docs = "\n".join(f'<document index="{n}" source="{chunks[i]["source"]}">\n{texts[i]}\n</document>'
                     for n, i in enumerate(picked, 1))
    client = make_client()
    resp = create(client, model=args.model, max_tokens=16000, output_config={"effort": "low"},
                  system="Answer using only the documents provided and cite document numbers like [1]. "
                         "If the documents do not contain the answer, say you don't know.",
                  messages=[{"role": "user", "content": f"<documents>\n{docs}\n</documents>\n\nQuestion: {args.question}"}])
    ensure_answered(resp)
    print("\n" + text_of(resp))
    print(f"\n[{describe_usage(resp.usage, args.model)}]")


if __name__ == "__main__":
    run(main)
