/* MedAssist's whole solution: every component, what it is used for, where it runs, and the use cases that touch it. */

export type UseCaseId = 'chat' | 'phone' | 'texts' | 'inbox' | 'dev';

export interface UseCase {
  id: UseCaseId;
  name: string;
  /** The path a request takes through the components, in order. */
  path: string;
}

export interface Lane {
  id: string;
  name: string;
  note: string;
  /** An Azure icon for the lane header, or none. */
  icon?: string;
}

export interface Part {
  id: string;
  lane: string;
  name: string;
  /** An Azure icon file name (without .svg), or a line icon prefixed with "line:". */
  icon: string;
  what: string;
  usedFor: string;
  runs: string;
  files: string[];
  uses: UseCaseId[];
  /** The one place the rules live. */
  core?: boolean;
}

export const USE_CASES: UseCase[] = [
  {
    id: 'chat',
    name: 'Portal chat',
    path: 'Portal page → FastAPI backend (or the ASP.NET Core API) → engine → Foundry model, with File Search and the Code Interpreter run by Foundry → function calls run by the clinic tools against the practice database → a confirmation text.',
  },
  {
    id: 'phone',
    name: 'Phone line',
    path: 'Patient rings → Communication Services → Event Grid → dev tunnel → the backend’s phone webhook → code checks the caller, screens for emergencies and confirms date of birth → engine A and the clinic tools. Speech and Translator work in both directions.',
  },
  {
    id: 'texts',
    name: 'Texts and reminders',
    path: 'A booking or cancellation succeeds → code sends the text through Communication Services and writes a reminder row to Table Storage → the Function sends the reminder 24 hours before the appointment.',
  },
  {
    id: 'inbox',
    name: 'Practice inbox',
    path: 'A patient’s message → the hosted agent in Foundry → a code screen for red flags → model triage → an answer from the practice documents held in its instructions, a fixed safety reply, or the clinician queue.',
  },
  {
    id: 'dev',
    name: 'Developer and testing',
    path: 'Command lines, DevUI and the Foundry portal; nine checked cases, each on a fresh database; offline tests with fakes in pytest and dotnet test.',
  },
];

export const LANES: Lane[] = [
  { id: 'channels', name: 'Channels', note: 'How people reach MedAssist' },
  { id: 'app', name: 'Application', note: 'Our code: the APIs' },
  { id: 'core', name: 'Agent core', note: 'Engines and the rules' },
  { id: 'data', name: 'Data', note: 'Practice systems and documents' },
  { id: 'foundry', name: 'Microsoft Foundry', note: 'AI Services account, project llm-lab', icon: 'foundry-project' },
  { id: 'azure', name: 'Azure platform', note: 'Messaging, voice, identity, infrastructure', icon: 'resource-groups' },
];

export const PARTS: Part[] = [
  // Channels
  {
    id: 'portal',
    lane: 'channels',
    name: 'Patient portal page',
    icon: 'line:browser',
    what: 'The /medassist page: a chat as the signed-in patient, beside “Behind the portal”, which shows the record, appointments, texts and audit log as they change.',
    usedFor: 'Patients ask questions, book and cancel appointments.',
    runs: 'The browser (React and TypeScript, built by Vite)',
    files: ['frontend/src/pages/medassist/MedAssistPage.tsx', 'frontend/src/services/medassistService.ts'],
    uses: ['chat'],
  },
  {
    id: 'phone',
    lane: 'channels',
    name: 'Phone line',
    icon: 'line:phone',
    what: 'The practice’s number. Before the agent hears a word, code decides who may call, screens every sentence for emergencies and checks the date of birth.',
    usedFor: 'Booking a doctor by phone, in the patient’s language.',
    runs: 'A Communication Services number, answered by the backend',
    files: ['backend/app/services/medassist_phone.py', 'backend/app/gateways/phone.py'],
    uses: ['phone'],
  },
  {
    id: 'inbox',
    lane: 'channels',
    name: 'Practice inbox',
    icon: 'line:inbox',
    what: 'Messages patients write to the practice through the portal.',
    usedFor: 'Each message is screened, triaged and answered, or queued for a clinician.',
    runs: 'Sent to the hosted agent in Foundry',
    files: ['examples/medassist/hosted/main.py'],
    uses: ['inbox'],
  },
  {
    id: 'texts',
    lane: 'channels',
    name: 'Text messages',
    icon: 'line:message',
    what: 'A confirmation when a booking or cancellation succeeds, and a reminder 24 hours before. Written by code, not the model, in the patient’s language.',
    usedFor: 'Telling the patient what was booked, and reminding them.',
    runs: 'The patient’s phone, through Communication Services (in the lab, one phone you choose)',
    files: ['examples/medassist/sms.py'],
    uses: ['chat', 'phone', 'texts'],
  },
  {
    id: 'devtools',
    lane: 'channels',
    name: 'Developer tools',
    icon: 'line:terminal',
    what: 'Command lines (medassist.py, medassist_af.py, MedAssist.Cli), Agent Framework DevUI on port 8091, and the Foundry portal and Foundry Toolkit for VS Code.',
    usedFor: 'Creating the agent, chatting with every tool call shown, running the checked cases.',
    runs: 'Your machine; the Foundry portal',
    files: ['examples/medassist/medassist.py', 'examples/medassist/medassist_af.py', 'dotnet/src/MedAssist.Cli/'],
    uses: ['dev'],
  },

  // Application
  {
    id: 'fastapi',
    lane: 'app',
    name: 'FastAPI backend',
    icon: 'line:server',
    what: 'The lab’s Python backend: the /api/medassist routes for the page, the phone webhooks (/api/medassist/phone/incoming and /events), a spending cap and the transcripts. Paid routes accept only the lab’s own pages (localhost and the X-LLM-Lab header).',
    usedFor: 'Serving the portal page and answering the phone line.',
    runs: '127.0.0.1:8000 (python -m backend)',
    files: ['backend/app/api/medassist.py', 'backend/app/services/medassist.py', 'backend/app/api/deps.py'],
    uses: ['chat', 'phone', 'texts'],
  },
  {
    id: 'aspnet',
    lane: 'app',
    name: 'ASP.NET Core API',
    icon: 'line:layers',
    what: 'MedAssist in C# on .NET 10, with the same routes and JSON as the Python backend, so the page works unchanged. Built in layers: Domain, Data, Application, Integrations.Foundry, Api and Cli.',
    usedFor: 'The portal chat from .NET, on either engine.',
    runs: '127.0.0.1:5080; the page uses it when LLM_LAB_MEDASSIST_API is set',
    files: ['dotnet/src/MedAssist.Api/', 'dotnet/README.md'],
    uses: ['chat', 'dev'],
  },
  {
    id: 'tunnel',
    lane: 'app',
    name: 'Dev tunnel',
    icon: 'line:tunnel',
    what: 'A public HTTPS address for the local backend (ngrok or Dev Tunnels), so Event Grid and Call Automation can reach the phone webhooks.',
    usedFor: 'Connecting the phone line to a backend on your machine.',
    runs: 'Your machine; its address is AFTERCARE_CALLBACK_URL',
    files: ['examples/medassist/setup-phone-line.sh'],
    uses: ['phone'],
  },

  // Agent core
  {
    id: 'engineA',
    lane: 'core',
    name: 'Engine A: prompt agent + our tool loop',
    icon: 'line:loop',
    what: 'Sends each turn to the MedAssist prompt agent in Foundry. When the model asks for a function call, our loop runs the tool and sends back the result, round after round, until the agent replies in words. About 40 lines.',
    usedFor: 'The portal chat, the phone line and the command line.',
    runs: 'The backend process (Python), or MedAssist.Integrations.Foundry (C#)',
    files: [
      'examples/medassist/clinic.py (run_turn)',
      'examples/medassist/medassist.py',
      'dotnet/src/MedAssist.Integrations.Foundry/PromptAgent/ToolLoop.cs',
    ],
    uses: ['chat', 'phone', 'dev'],
  },
  {
    id: 'engineB',
    lane: 'core',
    name: 'Engine B: Microsoft Agent Framework',
    icon: 'line:framework',
    what: 'The same agent defined in code, Agent(client=FoundryChatClient(...), tools=...), with agent.run() running the tool loop. Same instructions, documents and rules.',
    usedFor: 'The command line, DevUI, and the .NET API with MedAssist:Engine set to agent-framework.',
    runs: 'Your process (Python or C#)',
    files: [
      'examples/medassist/medassist_af.py',
      'dotnet/src/MedAssist.Integrations.Foundry/AgentFramework/AgentFrameworkEngine.cs',
    ],
    uses: ['chat', 'dev'],
  },
  {
    id: 'rules',
    lane: 'core',
    name: 'Clinic rules and tools',
    icon: 'line:shield',
    core: true,
    what: 'The four function tools (get_my_record, find_appointments, book_appointment, cancel_appointment) and their limits. The patient is fixed at sign-in, and no tool takes a patient id. Only a slot already shown can be booked, in a later turn. Cancelling takes two steps. One conditional UPDATE claims a slot. Every read, booking and cancellation is audited.',
    usedFor: 'Every engine and every channel goes through these. The rules hold whichever loop calls them.',
    runs: 'Inside the backend or CLI process: one implementation per language',
    files: [
      'examples/medassist/clinic.py',
      'dotnet/src/MedAssist.Domain/PatientSession.cs',
      'dotnet/src/MedAssist.Domain/Tools/ClinicTools.cs',
    ],
    uses: ['chat', 'phone', 'texts', 'dev'],
  },

  // Data
  {
    id: 'db',
    lane: 'data',
    name: 'Practice database',
    icon: 'line:database',
    what: 'SQLite: patients, clinicians’ diaries, appointments, texts sent and the audit log. The data is invented, and a reset rebuilds the diaries from today. Python and C# share the file, and a test checks both build the same data for a fixed day.',
    usedFor: 'The record the tools read, and the diary they book into.',
    runs: 'examples/medassist/data/medassist.db (ignored by git)',
    files: ['examples/medassist/clinic.py', 'dotnet/src/MedAssist.Data/PracticeSchema.cs'],
    uses: ['chat', 'phone', 'texts', 'dev'],
  },
  {
    id: 'transcripts',
    lane: 'data',
    name: 'Transcripts',
    icon: 'line:transcript',
    what: 'Every line of every conversation, page or phone, appended as it is said, with the time, patient, channel and speaker. A reset copies the database here first.',
    usedFor:
      'Keeping a record of what was said. On a real system this is health information, kept under a retention policy.',
    runs: 'generated/transcripts/<kind>/<YYYY-MM>/<conversation>.jsonl',
    files: ['backend/app/services/transcripts.py'],
    uses: ['chat', 'phone'],
  },
  {
    id: 'documents',
    lane: 'data',
    name: 'Practice documents',
    icon: 'line:documents',
    what: 'Opening hours, preparing for an appointment, prescriptions, results and urgent care, in Markdown.',
    usedFor:
      'Grounding the answers: uploaded to a Foundry vector store for the prompt agent’s File Search, and placed in full in the inbox agent’s instructions.',
    runs: 'examples/medassist/knowledge/*.md',
    files: [
      'examples/medassist/knowledge/practice-guide.md',
      'examples/medassist/knowledge/before-your-appointment.md',
      'examples/medassist/knowledge/prescriptions-results-urgent-care.md',
    ],
    uses: ['chat', 'phone', 'inbox'],
  },

  // Microsoft Foundry
  {
    id: 'models',
    lane: 'foundry',
    name: 'Foundry Models',
    icon: 'foundry-models',
    what: 'The gpt-5.4-mini deployment every engine calls, through the Responses API on the Foundry project.',
    usedFor: 'Choosing tools, writing replies and triaging inbox messages.',
    runs: 'AI Services account, Global Standard deployment',
    files: ['infra/resources.bicep'],
    uses: ['chat', 'phone', 'inbox', 'dev'],
  },
  {
    id: 'agentservice',
    lane: 'foundry',
    name: 'Foundry Agent Service',
    icon: 'foundry-agent-service',
    what: 'The MedAssist prompt agent: model, instructions and tool list, saved as a new version on each create. It also keeps each chat’s conversation, which is deleted when the chat ends.',
    usedFor: 'Engine A’s agent. It is listed in the Foundry portal and the Foundry Toolkit.',
    runs: 'The Foundry project',
    files: ['examples/medassist/medassist.py (create)', 'backend/app/gateways/foundry_agent.py'],
    uses: ['chat', 'phone', 'dev'],
  },
  {
    id: 'filesearch',
    lane: 'foundry',
    name: 'File Search',
    icon: 'search',
    what: 'Retrieves from the three practice documents in a Foundry vector store. Foundry runs it and reports the queries it used. Only the MedAssist prompt agent uses it.',
    usedFor: 'Questions only the documents can answer, such as how to prepare for a blood test.',
    runs: 'Foundry (vector store)',
    files: ['examples/medassist/medassist.py'],
    uses: ['chat', 'phone'],
  },
  {
    id: 'codeinterpreter',
    lane: 'foundry',
    name: 'Code Interpreter',
    icon: 'line:code',
    what: 'The model writes Python and Foundry runs it in a sandbox.',
    usedFor: 'Calculations, such as a BMI.',
    runs: 'Foundry’s sandbox',
    files: ['examples/medassist/medassist.py'],
    uses: ['chat'],
  },
  {
    id: 'hosted',
    lane: 'foundry',
    name: 'Hosted agent: practice inbox',
    icon: 'foundry-application',
    what: 'An Agent Framework workflow that Foundry runs in a managed container behind a stable endpoint. Code screens for red-flag words and answers emergencies with fixed text, the model triages, practice questions are answered from the documents (read into its instructions, not through File Search), and clinical messages go to a clinician queue.',
    usedFor:
      'Answering the practice inbox. It is the form Microsoft now recommends for workflows, as declarative workflows retire on 1 December 2026.',
    runs: 'A Foundry hosted agent (or locally on port 8088)',
    files: ['examples/medassist/hosted/main.py', 'examples/medassist/hosted/deploy.py'],
    uses: ['inbox'],
  },

  // Azure platform
  {
    id: 'acs',
    lane: 'azure',
    name: 'Communication Services',
    icon: 'communication-services',
    what: 'Sends the texts (SMS) and owns the practice phone number. Call Automation answers calls, speaks and listens.',
    usedFor: 'Confirmations, reminders and the phone line.',
    runs: 'Azure, in rg-llm-lab, tagged lab-part=medassist-texts',
    files: ['infra/modules/medassist-texts.bicep', 'examples/medassist/sms.py', 'backend/app/gateways/phone.py'],
    uses: ['phone', 'texts'],
  },
  {
    id: 'eventgrid',
    lane: 'azure',
    name: 'Event Grid',
    icon: 'event-grid',
    what: 'Tells the backend that a call is coming in, through the dev tunnel. Its first 100,000 operations a month are free.',
    usedFor: 'Routing incoming calls to the phone webhook.',
    runs: 'Azure: a subscription on the Communication Services resource',
    files: ['examples/medassist/setup-phone-line.sh'],
    uses: ['phone'],
  },
  {
    id: 'speech',
    lane: 'azure',
    name: 'Speech',
    icon: 'speech',
    what: 'Call Automation listens and speaks through the AI Services account, with a voice for the caller’s language, slower and with pauses for older patients.',
    usedFor: 'Turning the call into text and the replies into speech.',
    runs: 'The AI Services account; Communication Services has a role on it',
    files: ['infra/modules/medassist-texts.bicep', 'backend/app/gateways/phone.py'],
    uses: ['phone'],
  },
  {
    id: 'translator',
    lane: 'azure',
    name: 'Translator',
    icon: 'translator',
    what: 'Translates the line’s reviewed English wording, the agent’s replies and the texts into the patient’s language, and the caller’s words into English.',
    usedFor: 'Calls and texts in the patient’s language. The English goes into the record and the emergency screen.',
    runs: 'The AI Services account, signed in without keys',
    files: ['python/translator.py'],
    uses: ['phone', 'texts'],
  },
  {
    id: 'functions',
    lane: 'azure',
    name: 'Functions (Flex Consumption)',
    icon: 'function-apps',
    what: 'Every 15 minutes, sends the reminders that are due and deletes each one once Communication Services accepts it, so a failed send is tried again.',
    usedFor: 'Reminders the day before, with no server of ours running.',
    runs: 'Azure Functions, Python 3.12, managed identity',
    files: ['examples/medassist/reminders/function_app.py'],
    uses: ['texts'],
  },
  {
    id: 'storage',
    lane: 'azure',
    name: 'Storage account',
    icon: 'storage-accounts',
    what: 'The reminders table (one row per booking, due 24 hours before the appointment; cancelling deletes it) and the Function’s deployment package. Key access is switched off.',
    usedFor: 'Reminders waiting to be sent.',
    runs: 'Azure Table Storage',
    files: ['infra/modules/medassist-texts.bicep'],
    uses: ['texts'],
  },
  {
    id: 'identity',
    lane: 'azure',
    name: 'Entra ID and managed identity',
    icon: 'managed-identities',
    what: 'No keys anywhere. We sign in with az login (DefaultAzureCredential), the Function uses its managed identity, and role assignments give each only what it uses.',
    usedFor: 'Every call to Foundry, Communication Services, Translator and Storage.',
    runs: 'Microsoft Entra ID',
    files: ['infra/modules/medassist-texts.bicep', 'infra/resources.bicep'],
    uses: ['chat', 'phone', 'texts', 'inbox', 'dev'],
  },
  {
    id: 'bicep',
    lane: 'azure',
    name: 'Bicep and azd',
    icon: 'line:cube',
    what: 'azd up provisions the lab’s resources, this module included. setup-texts.sh deploys only the texts part into rg-llm-lab, and teardown-texts.sh removes it. setup-phone-line.sh connects the number to the backend.',
    usedFor: 'Creating and removing the Azure resources, repeatably.',
    runs: 'Your machine, or the infra pipeline in GitHub Actions',
    files: [
      'infra/main.bicep',
      'infra/modules/medassist-texts.bicep',
      'examples/medassist/setup-texts.sh',
      'examples/medassist/setup-phone-line.sh',
    ],
    uses: ['phone', 'texts', 'dev'],
  },
];
