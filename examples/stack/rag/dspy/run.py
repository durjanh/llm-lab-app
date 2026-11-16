"""RAG with DSPy: a module of retrieval plus ChainOfThought, then one BootstrapFewShot step on four questions."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/rag
import shared
from shared import checks, config, data

NAME = "rag/dspy"

if shared.need_claude(NAME):
    import dspy
    from sentence_transformers import SentenceTransformer

    dspy.configure(lm=dspy.LM(f"anthropic/{config.CLAUDE_MODEL}", max_tokens=300, cache=False))

    encoder = SentenceTransformer(config.LOCAL_EMBEDDING, device="cpu")
    corpus = [c.text for c in data.chunks()]
    embedder = dspy.Embedder(lambda texts: encoder.encode(texts, normalize_embeddings=True))
    retrieve = dspy.retrievers.Embeddings(corpus=corpus, embedder=embedder, k=3)

    class Handbook(dspy.Signature):
        """Answer the question using only the handbook excerpts, in one short sentence."""

        context: list[str] = dspy.InputField(desc="handbook excerpts")
        question: str = dspy.InputField()
        answer: str = dspy.OutputField()

    class RAG(dspy.Module):
        def __init__(self):
            super().__init__()
            self.answer = dspy.ChainOfThought(Handbook)

        def forward(self, question):
            passages = retrieve(question).passages
            return dspy.Prediction(context=passages, answer=self.answer(context=passages, question=question).answer)

    def section_of(passage):
        return passage.split(": ", 1)[0]

    by_question = {g.question: g for g in data.GOLD}


    def metric(example, pred, trace=None):
        return by_question[example.question].correct(pred.answer)

    # The unoptimised module first (scored quietly), then the optimised one, which prints the result line.
    base = RAG()
    correct0 = 0
    for g in data.GOLD:
        correct0 += g.correct(base(question=g.question).answer)

    train = [dspy.Example(question=g.question, answer=g.answer).with_inputs("question") for g in data.GOLD[::3]]  # 4 questions
    tuned = dspy.BootstrapFewShot(metric=metric, max_bootstrapped_demos=2, max_labeled_demos=0).compile(RAG(), trainset=train)

    def answer(question):
        out = tuned(question=question)
        return out.answer, [section_of(p) for p in out.context]

    shared.evaluate(NAME, answer, f"optimised with BootstrapFewShot on 4 questions; unoptimised scored {correct0}/12")
