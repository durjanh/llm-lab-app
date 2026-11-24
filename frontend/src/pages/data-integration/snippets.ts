/* Code samples for the page, as plain text highlighted once at load. */
import { highlight } from '@/components/highlight';

export const timeTravel =
  highlight(`# Train on the silver table exactly as it was, so a model can be rebuilt and compared later.
from pyspark.sql import SparkSession

spark = SparkSession.builder.getOrCreate()

# Delta Lake: read a past version by number or by time.
train = spark.read.format("delta").option("versionAsOf", 12).load("/lake/silver/tickets")
same = spark.sql("SELECT * FROM silver.tickets TIMESTAMP AS OF '2026-04-05'")

# Record the version with the model run, so the training set is never ambiguous.
version = spark.sql("DESCRIBE HISTORY silver.tickets LIMIT 1").collect()[0]["version"]
print("trained on silver.tickets version", version)`);

export const gatewayPolicy = highlight(
  `<!-- API Management: inbound policies for a language model API, applied to every app's calls -->
<policies>
  <inbound>
    <base />
    <!-- A semantic cache, kept apart per app so one app never sees another's answers -->
    <llm-semantic-cache-lookup score-threshold="0.05"
        embeddings-backend-id="embeddings-backend" embeddings-backend-auth="system-assigned">
      <vary-by>@(context.Subscription.Id)</vary-by>
    </llm-semantic-cache-lookup>
    <!-- Each subscription (one per app) gets its own tokens-per-minute budget; over it, 429 -->
    <llm-token-limit counter-key="@(context.Subscription.Id)"
        tokens-per-minute="150000" estimate-prompt-tokens="true" />
    <!-- Token counts per app to Application Insights, for chargeback -->
    <llm-emit-token-metric namespace="llm-usage">
      <dimension name="Subscription ID" />
    </llm-emit-token-metric>
    <!-- A backend pool: provisioned deployment at priority 1, pay-as-you-go at priority 2,
         each with a circuit breaker defined on the backend resource -->
    <set-backend-service backend-id="model-pool" />
  </inbound>
  <outbound>
    <base />
    <llm-semantic-cache-store duration="600" />
  </outbound>
</policies>`,
  'shell',
);

export const idempotentConsumer =
  highlight(`# An idempotent consumer: safe to receive the same event twice, because the stream promises at least once.
def handle(event):
    if store.already_applied(event["id"]):          # kept with the index, so it survives a crash
        return
    try:
        chunks = embed(split(load(event["doc"], event["version"])))
    except CorruptDocument:
        raise                                       # the client retries, then dead-letters it
    with store.transaction():
        # Upsert by document: replace the old chunks, never append beside them.
        store.delete_chunks(doc=event["doc"])
        store.insert_chunks(doc=event["doc"], version=event["version"], chunks=chunks)
        store.mark_applied(event["id"])
    # Only now move the checkpoint. A crash before this line means redelivery, which is harmless.
    checkpoint(event)`);

export const asyncReply =
  highlight(`# Async request-reply: accept a long agent job at once, run it from a queue, let the caller poll.
from uuid import uuid4
from fastapi import FastAPI, Response

app = FastAPI()

@app.post("/jobs", status_code=202)
def start(req: JobRequest, response: Response):
    job_id = str(uuid4())
    jobs.save(job_id, status="queued")
    queue.send({"job_id": job_id, "brief": req.brief})  # Service Bus, SQS or Pub/Sub
    response.headers["Location"] = f"/jobs/{job_id}"
    response.headers["Retry-After"] = "5"
    return {"job_id": job_id, "status": "queued"}

@app.get("/jobs/{job_id}")
def status(job_id: str):
    return jobs.get(job_id)          # queued, running, done (with the result) or failed

# The worker: peek-lock a message, do the work, then complete it. If the worker dies, the lock expires and
# another worker gets the message; after the maximum delivery count it goes to the dead-letter queue.
def worker():
    for msg in queue.receive(lock=True):
        jobs.save(msg["job_id"], status="running")
        result = run_agent(msg["brief"])
        jobs.save(msg["job_id"], status="done", result=result)
        queue.complete(msg)`);

export const outbox =
  highlight(`# Transactional outbox: the row and the event commit together, so neither is ever lost without the other.
with db.transaction() as tx:
    tx.execute("UPDATE policies SET body = %s, version = version + 1 WHERE id = %s", (body, policy_id))
    tx.execute(
        "INSERT INTO outbox (event_id, topic, payload) VALUES (%s, 'policy-changed', %s)",
        (str(uuid4()), json.dumps({"doc": policy_id})),
    )
# A relay (or CDC reading the outbox table) publishes outbox rows to the stream and marks them sent.`);
