import { api, type ApiClient } from './apiClient';

export type FieldType = 'text' | 'longtext' | 'date' | 'number' | 'money' | 'boolean' | 'choice' | 'list';

/** One question of the interview, for one field of the template. */
export interface TemplateField {
  name: string;
  question: string;
  type: FieldType;
  help: string;
  options: string[];
  required: boolean;
  group: string;
}

export interface DocTemplate {
  id: string;
  name: string;
  title: string;
  fields: TemplateField[];
  made_by_ai: boolean;
  text: string; // the template's text, with its {{ fields }} and {%p %} tags
  cost: number;
  // When AI made the template from a finished document:
  replaced?: { text: string; field: string; count: number }[];
  not_found?: { text: string; field: string }[];
  optional_clauses?: { field: string; starts_with: string }[];
}

export interface ProposedAnswer {
  field: string;
  value: string;
  quote: string; // the words in the source that support it
  confidence: 'high' | 'medium' | 'low';
}

export interface AssembledDoc {
  id: string;
  name: string;
  text: string;
  missing: string[]; // questions marked required that have no answer
}

export interface Review {
  summary: string;
  issues: { severity: 'high' | 'medium' | 'low'; issue: string; quote: string; suggestion: string }[];
  cost: number;
}

export type Answers = Record<string, string | boolean>;

/** Document automation: templates, filling the interview from documents, assembly and review. */
export class DocumentsService {
  constructor(private readonly client: ApiClient) {}

  /** A sample file: engagement-letter-template.docx, mutual-nda.docx or intake-email.txt. */
  async sample(name: string): Promise<File> {
    const blob = await this.client.blob(`/api/documents/samples/${encodeURIComponent(name)}`);
    return new File([blob], name, { type: blob.type });
  }

  /** mode template: a Word file with {{ fields }}. mode author: a finished document for AI to turn into a template. */
  addTemplate(file: File, mode: 'template' | 'author', model?: string): Promise<DocTemplate> {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('mode', mode);
    if (model) form.append('model', model);
    return this.client.post('/api/documents/templates', form);
  }

  downloadTemplate(template: Pick<DocTemplate, 'id' | 'name'>): Promise<void> {
    return this.client.saveFile(`/api/documents/templates/${encodeURIComponent(template.id)}/file`, template.name);
  }

  /**
   * Fill the interview: one message, typed, spoken or pasted, with documents attached if any, such as a
   * client's email or term sheet. Returns the values it gives, each with its quote and confidence, and a
   * reply asking for what is still missing.
   */
  chat(
    templateId: string,
    message: string,
    files: File[],
    answers: Answers,
    history: { role: 'user' | 'assistant'; text: string }[],
    model?: string,
  ): Promise<{ answers: ProposedAnswer[]; reply: string; cost: number }> {
    const form = new FormData();
    form.append('message', message);
    for (const file of files) form.append('files', file, file.name);
    form.append('answers', JSON.stringify(answers));
    form.append('history', JSON.stringify(history.slice(-20)));
    if (model) form.append('model', model);
    return this.client.post(`/api/documents/templates/${encodeURIComponent(templateId)}/chat`, form);
  }

  /** The document as the answers stand: values wrapped in ⟦ ⟧, empty fields as ⟦?question⟧. No AI. */
  preview(templateId: string, answers: Answers): Promise<{ text: string }> {
    return this.client.post(`/api/documents/templates/${encodeURIComponent(templateId)}/preview`, { answers });
  }

  /** Fills the template. No AI: the same answers always give the same document. */
  assemble(templateId: string, answers: Answers): Promise<AssembledDoc> {
    return this.client.post(`/api/documents/templates/${encodeURIComponent(templateId)}/assemble`, { answers });
  }

  download(doc: Pick<AssembledDoc, 'id' | 'name'>): Promise<void> {
    return this.client.saveFile(`/api/documents/assembled/${encodeURIComponent(doc.id)}`, doc.name);
  }

  review(documentId: string, model?: string): Promise<Review> {
    return this.client.post(`/api/documents/assembled/${encodeURIComponent(documentId)}/review`, model ? { model } : {});
  }
}

export const documentsService = new DocumentsService(api);
