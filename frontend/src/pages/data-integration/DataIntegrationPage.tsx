import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { LakehouseDemo } from './LakehouseDemo';
import { StoreChooser } from './StoreChooser';
import { GatewaySim } from './GatewaySim';
import { StreamSim } from './StreamSim';
import { asyncReply, gatewayPolicy, idempotentConsumer, outbox, timeTravel } from './snippets';
import './data-integration.css';

/* Data platforms and integration for AI: the lakehouse that feeds training and retrieval, choosing stores, an AI
   gateway shared by several apps, event streaming into a vector index, and the integration patterns around them.
   Everything runs in the browser on invented data; nothing here calls a model. */

const SECTIONS: [string, string][] = [
  ['lakehouse', 'Lakehouse'],
  ['stores', 'Choosing a store'],
  ['gateway', 'AI gateway'],
  ['streaming', 'Event streaming'],
  ['messaging', 'Queues, streams, webhooks, batch'],
  ['patterns', 'Integration patterns'],
];

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Sources land in bronze, are cleaned into silver and shaped into gold, which feeds features, the index and reports. */
function MedallionFlow() {
  const box = (x: number, y: number, w: number, title: string, sub: string, cls: string) => (
    <g className={`di-node ${cls}`}>
      <rect x={x} y={y} width={w} height={56} rx={8} />
      <text x={x + w / 2} y={y + 23} textAnchor="middle" className="di-t">
        {title}
      </text>
      <text x={x + w / 2} y={y + 41} textAnchor="middle" className="di-s">
        {sub}
      </text>
    </g>
  );
  const arrow = (x1: number, y1: number, x2: number, y2: number) => (
    <path d={`M${x1} ${y1} L${x2} ${y2}`} className="di-arrow" markerEnd="url(#di-arr)" />
  );
  return (
    <div className="di-diagram-scroll">
      <svg viewBox="0 0 800 210" className="di-flow" role="img" aria-labelledby="di-flow-t di-flow-d">
        <title id="di-flow-t">The medallion layers</title>
        <desc id="di-flow-d">
          Sources land unchanged in bronze. Rules clean them into silver. Gold shapes them for use. Gold and silver feed
          a feature table, a vector index and reports.
        </desc>
        <defs>
          <marker id="di-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0L10 5L0 10z" className="di-head" />
          </marker>
        </defs>
        {box(0, 77, 120, 'Sources', 'apps, files, events', 'src')}
        {box(160, 77, 130, 'Bronze', 'as landed, append-only', 'bronze')}
        {box(330, 77, 130, 'Silver', 'cleaned, unique, typed', 'silver')}
        {box(500, 77, 120, 'Gold', 'shaped for use', 'gold')}
        {box(660, 7, 140, 'Feature table', 'training and serving', 'serve')}
        {box(660, 77, 140, 'Vector index', 'chunks for RAG', 'serve')}
        {box(660, 147, 140, 'Reports and BI', 'semantic model', 'serve')}
        {arrow(120, 105, 158, 105)}
        {arrow(290, 105, 328, 105)}
        {arrow(460, 105, 498, 105)}
        {arrow(620, 100, 658, 40)}
        {arrow(460, 92, 658, 100)}
        {arrow(620, 112, 658, 172)}
        <text x="395" y="160" textAnchor="middle" className="di-s">
          quarantine: rows that break a rule
        </text>
        <path d="M395 133 L395 146" className="di-arrow dashed" />
      </svg>
    </div>
  );
}

export default function DataIntegrationPage() {
  return (
    <main className="page-data-integration">
      <p className="kicker">Data and integration</p>
      <h1>Data platforms and integration for AI</h1>
      <p className="lede">
        A model is only as good as the data that reaches it, and an AI feature is only as reliable as the plumbing
        around it. This page covers that plumbing: the lakehouse that feeds training and retrieval, choosing where data
        lives, a gateway shared by several apps, event streams that keep an index current, and the patterns that stop
        work being lost or done twice. Every demo runs in the browser on invented data and costs nothing.
      </p>
      <nav className="di-nav" aria-label="Sections">
        {SECTIONS.map(([id, name]) => (
          <a key={id} href={`#${id}`}>
            {name}
          </a>
        ))}
      </nav>

      <section id="lakehouse" className="di-section">
        <h2>1. The lakehouse and its medallion layers</h2>
        <p>
          A lakehouse keeps data as files in cheap object storage, in an open table format that adds what a database
          gives you: transactions, a schema, and history. The usual layout has three layers. <b>Bronze</b> holds data
          exactly as it arrived, so you can always reprocess it. <b>Silver</b> holds it cleaned: typed, deduplicated,
          validated and with personal data handled. <b>Gold</b> holds it shaped for a use: aggregates for reports,
          feature tables for models, text ready to chunk and embed.
        </p>
        <MedallionFlow />
        <p>
          Below are twelve invented support tickets from two loads. The second load repeats two tickets, renames the
          priority column and spells a product three ways; some dates are in other formats, one is impossible, and two
          tickets hold a phone number or email address. Switch the rules on one at a time and watch what reaches gold,
          the features and the vector index.
        </p>
        <LakehouseDemo />

        <h3>Open table formats, and why time travel matters for AI</h3>
        <p>
          <b>Delta Lake</b> and <b>Apache Iceberg</b> are the two common open table formats. Both store data as Parquet
          files plus a transaction log or metadata tree, which gives ACID writes (a reader never sees half a load),
          schema enforcement and evolution, and <b>time travel</b>: reading a table as it was at an earlier version. For
          machine learning that is what makes a model reproducible: record the table version with the training run, and
          you can rebuild exactly the data the model saw, compare two models fairly, or answer an auditor. See{' '}
          <Link to="/mlops">MLOps</Link> for the rest of that story.
        </p>
        <CodeBlock html={timeTravel} />
        <Table
          head={['Platform', 'Table format and storage', 'Where it fits']}
          rows={[
            [
              'Databricks',
              'Delta Lake (reads Iceberg too) on your cloud storage, governed by Unity Catalog',
              'Spark-first data engineering and ML on any of the three clouds; MLflow built in',
            ],
            [
              'Microsoft Fabric',
              'Delta tables in OneLake, one lake per organisation',
              'Microsoft estates: Power BI, Data Factory pipelines and notebooks in one SaaS product',
            ],
            [
              'BigQuery',
              'Native storage, plus BigLake tables over open formats including Iceberg',
              'Serverless SQL analytics on Google Cloud, with Vertex AI alongside',
            ],
            [
              'Snowflake',
              'Native storage, plus Iceberg tables',
              'SQL-first warehouse on any cloud, with sharing between accounts',
            ],
            [
              'Amazon S3 with Glue and Athena',
              'Iceberg (or Delta, Hudi) on S3, catalogued in the Glue Data Catalog',
              'Assemble-it-yourself lakehouse on AWS; Athena for SQL, EMR or Glue jobs for Spark',
            ],
          ]}
        />
        <p className="small muted">
          The choice is usually made by the estate the organisation already has and the skills of its team, not by
          features: all five can hold medallion layers and feed a model.
        </p>
      </section>

      <section id="stores" className="di-section">
        <h2>2. Choosing a store</h2>
        <p>
          Pick a store by how the data will be read and written, not by what is fashionable. Most AI systems end up with
          two or three: an operational database that is the source of truth, an index built from it for retrieval, and
          an analytical copy for reporting and training. The <Link to="/vector-db">vector database</Link> page runs one
          of these for real; <Link to="/data-agent">the data agent</Link> queries a warehouse through a semantic layer.
        </p>
        <StoreChooser />
      </section>

      <section id="gateway" className="di-section">
        <h2>3. An AI gateway in front of the models</h2>
        <p>
          Once several apps share model deployments, the rules that keep them fair and affordable belong in one place,
          not in every client. An AI gateway sits between the apps and the model endpoints and handles: a token budget
          per app, a semantic cache, routing across a pool of backends (provisioned capacity first, pay-as-you-go when
          it is full), a circuit breaker when a backend fails, and token logging per app so each team can be charged for
          what it used. Azure API Management has these as built-in policies; on other clouds the same jobs are done by
          an API gateway with custom code, or by an open-source LLM proxy.
        </p>
        <p>
          Three invented apps share the capacity below. Try doubling the traffic, removing the spillover, or failing the
          provisioned backend with and without the breaker.
        </p>
        <GatewaySim />
        <h3>The same rules as API Management policies</h3>
        <CodeBlock html={gatewayPolicy} />
        <p>
          What happens inside one app when its calls are refused, and how backoff and fallback models work, are on{' '}
          <Link to="/resilience">rate limits and resilience</Link> and <Link to="/model-failover">model failover</Link>.
          Why a similarity threshold alone is not a safe cache rule is shown on{' '}
          <Link to="/semantic-cache">the semantic cache</Link>: keep the cache apart per app (the <code>vary-by</code>{' '}
          above) and per prompt version.
        </p>
      </section>

      <section id="streaming" className="di-section">
        <h2>4. Event streaming into a vector index</h2>
        <p>
          A RAG index goes stale the moment a source document changes. Rather than rebuilding it nightly, publish each
          change as an event and let a consumer re-embed just that document. Azure Event Hubs, Apache Kafka (and its
          managed forms, such as Confluent Cloud and Amazon MSK), Amazon Kinesis and Google Pub/Sub all work this way.
          The ideas to know:
        </p>
        <ul>
          <li>
            <b>Partitions</b> split a stream so it can be read in parallel. Order is kept <i>within</i> a partition,
            never across them.
          </li>
          <li>
            <b>The partition key</b> decides where an event goes. Use the document id, so every change to one document
            lands in the same partition, in order.
          </li>
          <li>
            <b>Consumer groups</b> each read the whole stream at their own pace: the indexer, an audit log and an
            analytics loader can all read the same events.
          </li>
          <li>
            <b>Offsets and checkpoints</b>: a consumer records how far it has got. After a crash it starts again from
            the last checkpoint, so anything read since is delivered again. Delivery is at least once; design for
            duplicates.
          </li>
          <li>
            <b>Retention and replay</b>: events are kept for a set time, so a new consumer group can read from the
            start, for example to rebuild the index with a new embedding model.
          </li>
        </ul>
        <p>
          The stream below starts with a backlog of twelve events. Run it as it is, then crash the consumer between
          checkpoints, then switch on the defences one by one. Turning off the partition key shows the subtler fault: an
          older version of a document is indexed after a newer one.
        </p>
        <StreamSim />
        <h3>The consumer that survives all of it</h3>
        <CodeBlock html={idempotentConsumer} />
      </section>

      <section id="messaging" className="di-section">
        <h2>5. Queues, streams, webhooks and batch</h2>
        <p>They all move work from one system to another, but they promise different things.</p>
        <Table
          head={['Mechanism', 'What it promises', 'Fits AI work like', 'Watch out for']}
          rows={[
            [
              <b key="q">Queue</b>,
              'Each message is handled by one worker, then removed. Locks, retries and a dead-letter queue are built in.',
              'Long agent jobs, document processing, anything slower than an HTTP timeout. Workers scale with queue length.',
              'A message handled twice if a worker dies after the work but before completing it: keep the work idempotent.',
            ],
            [
              <b key="s">Stream</b>,
              'An ordered, retained log per partition, read by many consumer groups, replayable.',
              'Keeping indexes and features in step with sources, telemetry, feeding several consumers from one change.',
              'Ordering only within a partition; one poison event blocks its partition without a dead-letter path.',
            ],
            [
              <b key="w">Webhook</b>,
              'An HTTP call to you when something happens elsewhere.',
              'A SaaS tool telling you a ticket or file changed, which you then put on a queue.',
              'Senders retry and give up; verify the signature, reply fast, and do the work later from a queue.',
            ],
            [
              <b key="b">Batch</b>,
              'A scheduled job over a whole set of data.',
              'Nightly re-embedding, evaluation runs, training sets, batch model APIs at a discount.',
              'Data as old as the last run; a failed run must be safe to rerun.',
            ],
          ]}
        />
        <h3>Async request-reply for long agent jobs</h3>
        <p>
          An agent that researches, drafts and checks can run for minutes, far longer than a client or load balancer
          will hold a connection. Accept the job at once with <code>202 Accepted</code> and a status URL, put it on a
          queue, and let the client poll (or receive a webhook) until it is done. The lab&apos;s own long runs, such as
          the <Link to="/harness">harness</Link>, use a background run with a stream for the same reason.
        </p>
        <CodeBlock html={asyncReply} />
      </section>

      <section id="patterns" className="di-section">
        <h2>6. Integration patterns</h2>
        <Table
          head={['Pattern', 'What it is', 'Use it for', 'The failure it prevents']}
          rows={[
            [
              'Request-reply',
              'Call and wait for the answer.',
              'Short model calls in a chat, lookups, tool calls that answer in seconds.',
              'Nothing, by itself: add timeouts, retries with backoff, and a circuit breaker.',
            ],
            [
              'Async request-reply',
              '202 with a status URL; the work runs from a queue.',
              'Agent jobs, long extractions, anything over about 30 seconds.',
              'Timed-out connections that leave the client unsure whether the work happened.',
            ],
            [
              'Publish-subscribe',
              'One event, any number of independent subscribers.',
              'A document changed: re-index, re-classify, notify, audit.',
              'One service calling five others in turn, failing when any of them is down.',
            ],
            [
              'Transactional outbox',
              'Write the change and its event in one database transaction; a relay publishes the event.',
              'Any database change that other systems, such as an index, must hear about.',
              'The dual write: the row saved but the event lost, or the event sent for a change that rolled back.',
            ],
            [
              'Saga with compensation',
              'A multi-step process where each step has an undo, run when a later step fails.',
              'Agent actions across systems: book, charge, confirm; refund and release if confirm fails.',
              'Half-finished processes and a distributed transaction that no one can hold open.',
            ],
            [
              'Change data capture (CDC)',
              "Read the database's own change log and turn each change into an event.",
              'Keeping a vector index, search index or lakehouse in step with an operational database.',
              'Nightly full rebuilds, and indexes that answer from deleted or outdated rows.',
            ],
            [
              'Idempotent consumer',
              'Remember what has been applied; upsert rather than append.',
              'Every consumer of a queue or stream, because delivery is at least once.',
              'Duplicate chunks, double charges, the same email sent twice.',
            ],
          ]}
        />
        <h3>The outbox, in code</h3>
        <CodeBlock html={outbox} />
        <p>
          CDC reading the outbox table, or the source table directly, is how the{' '}
          <Link to="/search-pipeline">search pipeline</Link> and an index like the one on the{' '}
          <Link to="/vector-db">vector database</Link> page stay current without a full rebuild. Which cloud service
          does each job on Azure, Google Cloud and AWS is on{' '}
          <Link to="/multicloud">one architecture, three clouds</Link>.
        </p>

        <div className="takeaways">
          <h3>What to take away</h3>
          <ul>
            <li>
              Bronze keeps the raw data so you can always reprocess; quality rules belong between bronze and silver.
            </li>
            <li>Record the table version with every training run and every index build, so both can be rebuilt.</li>
            <li>Mask personal data before it is embedded: removing it from a vector index later is much harder.</li>
            <li>
              Choose stores by access pattern; expect a source of truth plus an index plus an analytical copy, kept in
              step by CDC or an outbox.
            </li>
            <li>Put token budgets, routing, caching and chargeback in a shared gateway, not in every app.</li>
            <li>
              Streams and queues deliver at least once: partition by the entity id, make every consumer idempotent, and
              give poison messages a dead-letter queue.
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
