import {
  ArchDiagram,
  type DiagramArrow,
  type DiagramBox,
  type DiagramGroup,
  type DiagramLabel,
} from '@/components/architecture/ArchDiagram';
import { PARTS, type UseCaseId } from './data';

/* MedAssist's interaction diagram: where each box sits, and which use cases travel along each arrow. */

const GROUPS: DiagramGroup[] = [
  { x: 190, y: 20, w: 520, h: 420, label: 'OUR APPLICATION · PYTHON OR .NET 10', dashed: false },
  { x: 750, y: 20, w: 350, h: 420, label: 'MICROSOFT FOUNDRY', dashed: true },
  // Labelled at the right, clear of the arrows that come down into the Azure row.
  { x: 190, y: 480, w: 910, h: 200, label: 'AZURE PLATFORM · SIGNED IN WITH ENTRA ID', dashed: true, right: true },
];

const BOXES: DiagramBox[] = [
  { part: 'portal', x: 0, y: 58, w: 150, h: 64, title: ['Patient'], sub: ['portal page'] },
  { part: 'phone', x: 0, y: 560, w: 150, h: 64, title: ['Patient'], sub: ['phone call'] },
  {
    part: 'fastapi',
    x: 210,
    y: 58,
    w: 200,
    h: 120,
    title: ['Backend API'],
    sub: ['FastAPI or ASP.NET Core', 'spend cap, transcripts,', 'call webhook'],
  },
  {
    part: 'engineA',
    x: 500,
    y: 58,
    w: 190,
    h: 76,
    title: ['Agent engine'],
    sub: ['our tool loop or', 'Agent Framework'],
  },
  { part: 'rules', x: 500, y: 190, w: 190, h: 60, title: ['Clinic rules'], sub: ['and function tools'] },
  { part: 'db', x: 500, y: 320, w: 190, h: 60, title: ['Practice database'], sub: ['SQLite'] },
  {
    part: 'agentservice',
    x: 770,
    y: 58,
    w: 310,
    h: 60,
    title: ['Foundry Agent Service'],
    sub: ['MedAssist prompt agent'],
  },
  { part: 'filesearch', x: 770, y: 140, w: 230, h: 50, title: ['File Search,'], sub: ['Code Interpreter'] },
  { part: 'models', x: 770, y: 215, w: 310, h: 56, title: ['Foundry Models'], sub: ['gpt-5.4-mini'] },
  { part: 'inbox', x: 770, y: 335, w: 90, h: 70, title: ['Inbox'], sub: ['message'], stack: true, dashed: true },
  { part: 'hosted', x: 890, y: 340, w: 190, h: 60, title: ['Hosted agent'], sub: ['inbox workflow'] },
  { part: 'acs', x: 210, y: 515, w: 120, h: 140, title: ['Communication', 'Services'], stack: true },
  { part: 'translator', x: 342, y: 515, w: 120, h: 140, title: ['Speech and', 'Translator'], stack: true },
  { part: 'eventgrid', x: 474, y: 515, w: 120, h: 140, title: ['Event Grid'], sub: ['call events'], stack: true },
  { part: 'storage', x: 606, y: 515, w: 116, h: 140, title: ['Storage'], sub: ['reminder rows'], stack: true },
  { part: 'functions', x: 752, y: 515, w: 116, h: 140, title: ['Function'], sub: ['every 15 min'], stack: true },
  { part: 'identity', x: 880, y: 515, w: 205, h: 140, title: ['Entra ID'], sub: ['no keys anywhere'], stack: true },
];

const ARROWS: DiagramArrow[] = [
  { d: 'M150 90 H210', uses: ['chat'] },
  { d: 'M410 92 H500', uses: ['chat', 'phone', 'dev'] },
  { d: 'M690 90 H770', uses: ['chat', 'phone', 'dev'], both: true },
  { d: 'M595 134 V190', uses: ['chat', 'phone', 'dev'] },
  { d: 'M595 250 V320', uses: ['chat', 'phone', 'texts', 'dev'] },
  { d: 'M690 230 H718 V515', uses: ['texts'] },
  { d: 'M260 178 V515', uses: ['phone', 'texts'], both: true },
  { d: 'M380 178 V515', uses: ['phone'] },
  { d: 'M480 515 V150 H410', uses: ['phone'] },
  { d: 'M150 592 H210', uses: ['phone'] },
  { d: 'M752 585 H722', uses: ['texts'] },
  { d: 'M810 655 V668 H270 V655', uses: ['texts'] },
  { d: 'M885 118 V140', uses: ['chat', 'dev'] },
  { d: 'M1050 118 V215', uses: ['chat', 'phone', 'dev'] },
  { d: 'M1050 340 V271', uses: ['inbox'] },
  { d: 'M860 370 H890', uses: ['inbox'] },
];

const LABELS: DiagramLabel[] = [
  { x: 180, y: 82, lines: ['HTTPS'], anchor: 'middle', uses: ['chat'] },
  { x: 455, y: 84, lines: ['run a turn'], anchor: 'middle', uses: ['chat', 'phone', 'dev'] },
  { x: 730, y: 68, lines: ['Responses', 'API'], anchor: 'middle', uses: ['chat', 'phone', 'dev'] },
  { x: 603, y: 166, lines: ['function calls'], uses: ['chat', 'phone', 'dev'] },
  { x: 603, y: 290, lines: ['read, book, audit'], uses: ['chat', 'phone', 'texts', 'dev'] },
  { x: 727, y: 466, lines: ['reminder row'], uses: ['texts'] },
  { x: 254, y: 296, lines: ['calls,', 'texts'], anchor: 'end', uses: ['phone', 'texts'] },
  { x: 386, y: 380, lines: ['translate'], uses: ['phone'] },
  { x: 474, y: 226, lines: ['incoming call,', 'via dev tunnel'], anchor: 'end', uses: ['phone'] },
  { x: 180, y: 584, lines: ['rings'], anchor: 'middle', uses: ['phone'] },
];

/** MedAssist as an architecture diagram: the components in their boundaries and an arrow for each call between them. */
export function InteractionDiagram({
  useCase,
  selected,
  onSelect,
}: {
  useCase: UseCaseId | null;
  selected: string;
  onSelect: (part: string) => void;
}) {
  return (
    <ArchDiagram
      width={1100}
      height={690}
      label="How MedAssist's components interact"
      headings={[{ x: 0, y: 42, text: 'CHANNELS' }]}
      groups={GROUPS}
      boxes={BOXES}
      arrows={ARROWS}
      labels={LABELS}
      parts={PARTS}
      active={useCase}
      selected={selected}
      onSelect={onSelect}
    />
  );
}
