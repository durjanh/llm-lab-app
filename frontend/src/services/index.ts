/* Every call to the lab backend goes through these services, which share one axios client. */
export { ApiClient, ApiError, api } from './apiClient';
export { StatusService, statusService, type LiveStatus } from './statusService';
export {
  MessagesService,
  messagesService,
  type ClaudeMessage,
  type ContentBlock,
  type MessagesRequest,
  type MessagesResult,
} from './messagesService';
export {
  HarnessService,
  harnessService,
  type HarnessEvent,
  type HarnessRunRequest,
  type Scenario,
} from './harnessService';
export {
  SkillsService,
  skillsService,
  type SkillFile,
  type SkillId,
  type SkillsEvent,
  type SkillsRunRequest,
} from './skillsService';
export { SampleService, sampleService } from './sampleService';
export {
  DecksService,
  decksService,
  MAX_FILES,
  MAX_FILE_MB,
  SOURCE_EXTENSIONS,
  type DecksEvent,
  type DeckTurnRequest,
} from './decksService';
export {
  SitesService,
  sitesService,
  type SiteDetail,
  type SiteEvent,
  type SiteFile,
  type SiteShot,
  type SiteSummary,
  type SiteTurnRequest,
} from './sitesService';
export {
  TutorService,
  tutorService,
  type PronunciationScores,
  type SpeechToken,
  type TutorConfig,
  type TutorEvent,
  type TutorFeedback,
  type TutorImage,
  type TutorLevel,
  type TutorScenario,
  type TutorTurnRequest,
  type WordScore,
} from './tutorService';
export {
  DocumentsService,
  documentsService,
  type Answers,
  type AssembledDoc,
  type DocTemplate,
  type FieldType,
  type ProposedAnswer,
  type Review,
  type TemplateField,
} from './documentsService';
export { McpLabService, mcpLabService, type McpExchange, type McpStep } from './mcpLabService';
export {
  CaseworkService,
  caseworkService,
  type AuditEntry,
  type CaseEvent,
  type CaseSummary,
  type CaseworkInfo,
  type Checks,
  type Compensation,
  type Draft,
  type EvalEvent,
  type EvalRow,
} from './caseworkService';
export {
  MedAssistService,
  medassistService,
  type Appointment,
  type MedAssistInfo,
  type MedAssistPatient,
  type MedAssistReply,
  type MedAssistStep,
  type PracticeState,
  type PhoneLineInfo,
} from './medassistService';
export {
  ReviewsService,
  reviewsService,
  type Analysis,
  type AnalyzeResult,
  type ClaudeReading,
  type ProductReview,
  type ReviewsInfo,
  type Sentiment,
} from './reviewsService';
export {
  AftercareService,
  aftercareService,
  type AftercareInfo,
  type AftercareStep,
  type Board,
  type CareTask,
  type Engine,
  type AftercareEvalEvent,
  type HospitalRecord,
  type PhoneInfo,
  type PhoneState,
  type StartResult,
  type TurnResult,
  type WorkItem,
} from './aftercareService';
export {
  GuardrailsService,
  guardrailsService,
  type DeploymentFilter,
  type Evaluation,
  type Groundedness,
  type GuardrailsInfo,
  type ImageCheck,
  type Moderation,
  type Pii,
  type PipelineResult,
  type Shield,
  type Stage,
  type TestCase,
} from './guardrailsService';
export {
  UnderstandingService,
  understandingService,
  type Box,
  type CuField,
  type CuResult,
  type MediaKind,
  type UnderstandingInfo,
  type VisionResult,
} from './understandingService';
export {
  ImageGenService,
  imagegenService,
  type GenerateResult,
  type GeneratedImage,
  type ImageGenInfo,
  type PolicyCheck,
} from './imagegenService';
export {
  SearchLabService,
  searchlabService,
  type AskResult,
  type Health,
  type IngestReport,
  type QueryResult,
  type RelevanceResult,
  type SearchHit,
  type SearchLabInfo,
  type SearchMode,
} from './searchlabService';
export {
  TranslateService,
  translateService,
  type AudioAnswer,
  type ComplaintEntry,
  type LlmTranslation,
  type TranslateInfo,
  type TranslatorResult,
} from './translateService';
export {
  FoundryOpsService,
  foundryopsService,
  type Deployment,
  type EvalReport,
  type OpsEvalRow,
  type MetricSeries,
  type OpsInfo,
  type Quota,
  type SecurityReport,
  type Span,
  type TraceReport,
} from './foundryopsService';
export {
  DataAgentService,
  dataagentService,
  type AgentEvent,
  type DataQuery,
  type Filter,
  type ModelField,
  type ModelTopic,
  type SchemaTable,
  type QueryResult as DataQueryResult,
  type Tile,
  type Viewer as DataViewer,
  type Viz,
} from './dataagentService';
export {
  CodingService,
  codingService,
  type CodingEvent,
  type CodingInfo,
  type CodingMode,
  type CodingState,
  type CodingWorkspace,
  type ShotImage,
  type Todo as CodingTodo,
} from './codingService';
export { DietService, dietService, type DietPlan, type DietReply, type DietState } from './dietService';
