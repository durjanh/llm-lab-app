import type { DiagramArrow, DiagramBox, DiagramGroup, DiagramLabel } from '@/components/architecture/ArchDiagram';
import type { ViewId } from './data';

/* Where each box sits on the whole-lab diagram (1100 × 760 units), and which views travel along each arrow. */

const ALL: ViewId[] = ['claude', 'gpt', 'local', 'agents', 'azureai', 'phone', 'coding'];

export const WIDTH = 1100;
export const HEIGHT = 760;

export const HEADINGS = [{ x: 0, y: 42, text: 'CLIENTS' }];

export const GROUPS: DiagramGroup[] = [
  { x: 180, y: 20, w: 520, h: 450, label: 'THIS MACHINE' },
  { x: 195, y: 50, w: 345, h: 405, label: 'LAB BACKEND · FASTAPI :8000' },
  { x: 740, y: 20, w: 360, h: 150, label: 'ANTHROPIC', dashed: true },
  { x: 740, y: 200, w: 360, h: 270, label: 'MICROSOFT FOUNDRY', dashed: true },
  { x: 180, y: 510, w: 920, h: 215, label: 'AZURE PLATFORM · SIGNED IN WITH ENTRA ID', dashed: true, right: true },
];

export const BOXES: DiagramBox[] = [
  // Clients
  { part: 'pages', x: 0, y: 75, w: 150, h: 64, title: ['Lab pages'], sub: ['React, Vite'] },
  { part: 'scripts', x: 0, y: 160, w: 150, h: 64, title: ['Scripts'], sub: ['import the model', 'client directly'] },
  { part: 'browsermodels', x: 0, y: 245, w: 150, h: 64, title: ['Browser models'], sub: ['GPT-2, embedder'] },
  { part: 'ci', x: 0, y: 500, w: 150, h: 64, title: ['GitHub Actions'], sub: ['azd, eval gate'] },
  { part: 'phones', x: 0, y: 590, w: 150, h: 64, title: ['Phones'], sub: ['calls and texts'] },
  // The backend
  { part: 'guards', x: 210, y: 85, w: 150, h: 56, title: ['Guards'], sub: ['lab page, budget'] },
  {
    part: 'services',
    x: 210,
    y: 165,
    w: 150,
    h: 76,
    title: ['Services, runs'],
    sub: ['one per area,', 'NDJSON streams'],
  },
  { part: 'spend', x: 210, y: 265, w: 150, h: 56, title: ['Spend tracker'], sub: ['priced per reply'] },
  { part: 'data', x: 210, y: 345, w: 150, h: 90, title: ['Local data'], sub: ['SQLite, files,', 'transcripts'] },
  {
    part: 'client',
    x: 400,
    y: 85,
    w: 130,
    h: 120,
    title: ['Model client'],
    sub: ['Claude, GPT', 'or local'],
    stack: true,
  },
  {
    part: 'gateways',
    x: 400,
    y: 230,
    w: 130,
    h: 90,
    title: ['Gateways'],
    sub: ['Azure, Foundry,', 'phone, Chrome'],
    stack: true,
  },
  { part: 'coding', x: 430, y: 345, w: 100, h: 95, title: ['Coding', 'agent'], sub: ['Agent SDK'], stack: true },
  // This machine, outside the backend
  { part: 'localmodel', x: 560, y: 85, w: 130, h: 70, title: ['Local model'], sub: ['Docker Model', 'Runner'] },
  { part: 'tokenizers', x: 560, y: 180, w: 130, h: 64, title: ['Tokenizers'], sub: ['Hugging Face'] },
  { part: 'chrome', x: 560, y: 270, w: 130, h: 56, title: ['Chrome'], sub: ['DevTools'] },
  { part: 'sandbox', x: 560, y: 350, w: 130, h: 64, title: ['Sandbox'], sub: ['Docker or OS'] },
  // Anthropic
  {
    part: 'claude',
    x: 755,
    y: 50,
    w: 330,
    h: 105,
    title: ['Claude API'],
    sub: ['Haiku, Sonnet, Opus 5.5', 'server tools, Files, Skills,', 'code execution, MCP'],
  },
  // Microsoft Foundry
  { part: 'gpt', x: 755, y: 230, w: 330, h: 50, title: ['GPT deployments'], sub: ['gpt-5.4-mini, gpt-4.1-mini'] },
  { part: 'promptagents', x: 755, y: 290, w: 330, h: 50, title: ['Prompt agents'], sub: ['MedAssist, Aftercare'] },
  {
    part: 'agentframework',
    x: 755,
    y: 350,
    w: 330,
    h: 50,
    title: ['Agent Framework'],
    sub: ['agents, workflows, hosted'],
  },
  {
    part: 'foundrytools',
    x: 755,
    y: 410,
    w: 330,
    h: 50,
    title: ['Foundry Tools'],
    sub: ['Language, Safety, Translator, images'],
  },
  // Azure platform
  { part: 'search', x: 195, y: 545, w: 118, h: 150, title: ['AI Search'], sub: ['indexes'], stack: true },
  { part: 'speech', x: 323, y: 545, w: 118, h: 150, title: ['Speech'], sub: ['voices'], stack: true },
  { part: 'acs', x: 451, y: 545, w: 118, h: 150, title: ['Communication', 'Services'], stack: true },
  { part: 'eventgrid', x: 579, y: 545, w: 118, h: 150, title: ['Event Grid'], sub: ['call events'], stack: true },
  {
    part: 'functions',
    x: 707,
    y: 545,
    w: 118,
    h: 150,
    title: ['Functions,', 'Storage'],
    sub: ['reminders'],
    stack: true,
  },
  {
    part: 'containerapps',
    x: 835,
    y: 545,
    w: 118,
    h: 150,
    title: ['Container', 'Apps'],
    sub: ['sandbox'],
    stack: true,
  },
  { part: 'entra', x: 963, y: 545, w: 122, h: 150, title: ['Entra ID'], sub: ['no keys'], stack: true },
];

export const ARROWS: DiagramArrow[] = [
  { d: 'M150 107 H210', uses: ALL },
  { d: 'M285 141 V165', uses: ALL },
  { d: 'M360 185 H400', uses: ['claude', 'gpt', 'local', 'coding'] },
  { d: 'M360 235 H400', uses: ['agents', 'azureai', 'phone', 'coding'] },
  { d: 'M285 241 V265', uses: ['claude', 'gpt', 'agents', 'azureai', 'coding'] },
  { d: 'M210 225 H200 V390 H210', uses: ['claude', 'agents', 'phone', 'coding'] },
  { d: 'M465 85 V40 H720 V100 H755', uses: ['claude'] },
  { d: 'M530 115 H560', uses: ['local'] },
  { d: 'M530 165 H715 V240 H755', uses: ['gpt'] },
  { d: 'M530 380 H560', uses: ['coding'] },
  { d: 'M530 298 H560', uses: ['coding'] },
  { d: 'M530 258 H730 V315 H755', uses: ['agents', 'phone'] },
  { d: 'M730 315 V375 H755', uses: ['agents'] },
  { d: 'M730 375 V435 H755', uses: ['azureai', 'phone'] },
  { d: 'M410 320 V510', uses: ['azureai', 'phone', 'coding'] },
  { d: 'M600 545 V472', uses: ['phone'] },
  { d: 'M75 654 V738 H510 V695', uses: ['phone'] },
  { d: 'M150 532 H180', uses: ['agents'] },
];

export const LABELS: DiagramLabel[] = [
  { x: 180, y: 100, lines: ['HTTPS'], anchor: 'middle', uses: ALL },
  { x: 590, y: 34, lines: ['Messages API'], anchor: 'middle', uses: ['claude'] },
  { x: 622, y: 177, lines: ['Chat Completions'], anchor: 'middle', uses: ['gpt'] },
  { x: 416, y: 492, lines: ['Azure SDKs, REST'], uses: ['azureai', 'phone', 'coding'] },
  { x: 606, y: 494, lines: ['call events'], uses: ['phone'] },
  { x: 88, y: 702, lines: ['rings'], uses: ['phone'] },
];
