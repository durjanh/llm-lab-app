/* Plain line icons for the parts that are our own code or not Azure services. They draw in the current text colour. */

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const LINE_ICONS: Record<string, string> = {
  browser: svg(
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8.5h18"/><path d="M6 6.3h.01M8.5 6.3h.01"/>',
  ),
  phone: svg(
    '<path d="M6.6 3.5h2.6l1.3 4-2 1.4a11 11 0 0 0 6.6 6.6l1.4-2 4 1.3v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z"/>',
  ),
  inbox: svg('<path d="M3 13l2.5-8h13L21 13v6H3z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>'),
  message: svg('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'),
  terminal: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12.5 15H17"/>'),
  server: svg(
    '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01M12 7.5h5M12 16.5h5"/>',
  ),
  layers: svg('<path d="M12 3l9 4.5-9 4.5-9-4.5z"/><path d="M3 12l9 4.5 9-4.5"/><path d="M3 16.5L12 21l9-4.5"/>'),
  tunnel: svg('<path d="M3 20V12a9 9 0 0 1 18 0v8"/><path d="M8 20v-7a4 4 0 0 1 8 0v7"/><path d="M2 20h20"/>'),
  loop: svg(
    '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  ),
  framework: svg(
    '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><path d="M17.25 13.5v7.5M13.5 17.25H21"/>',
  ),
  shield: svg('<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'),
  database: svg(
    '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13"/><path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>',
  ),
  transcript: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 11h7M9 14h7M9 17h4"/>'),
  documents: svg('<path d="M8 3h8l3 3v12H8z"/><path d="M16 3v3h3"/><path d="M5 7v14h11"/><path d="M11 10h5M11 13h5"/>'),
  code: svg('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14"/>'),
  cube: svg('<path d="M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5z"/><path d="M3.5 7.25L12 12l8.5-4.75M12 12v9.5"/>'),
  spark: svg('<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/>'),
  container: svg(
    '<rect x="3" y="7" width="18" height="12" rx="1.5"/><path d="M7 7v12M11 7v12M15 7v12"/><path d="M6 4h4v3H6zM11 4h4v3h-4z"/>',
  ),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  script: svg('<path d="M6 3h10l3 3v15H6z"/><path d="M9 10l2 2-2 2M13 15h3"/>'),
  pipeline: svg(
    '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6 8l5 8.3M18 8l-5 8.3"/>',
  ),
  tokens: svg(
    '<rect x="3" y="6" width="5" height="5" rx="1"/><rect x="10" y="6" width="5" height="5" rx="1"/><rect x="17" y="6" width="4" height="5" rx="1"/><rect x="3" y="13" width="8" height="5" rx="1"/><rect x="13" y="13" width="8" height="5" rx="1"/>',
  ),
  chip: svg(
    '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  ),
  money: svg(
    '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 9.5v5M17.5 9.5v5"/>',
  ),
};
