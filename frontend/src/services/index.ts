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
} from './medassistService';
