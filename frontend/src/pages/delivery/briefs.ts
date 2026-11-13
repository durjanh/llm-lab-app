/** Three invented briefs to try the design tool on. */
export const BRIEFS = [
  {
    label: 'Financial services',
    text: 'Fenwick & Rowe Building Society handles about 1,800 mortgage-arrears and complaints emails a week. Handlers spend most of their time reading the customer history and finding the right policy before they can reply. We want a tool that drafts a reply and a case summary for a handler to approve. It must follow FCA complaint-handling rules, keep customer data in the UK and leave a full audit trail. The data sits in a case system with a REST API. Target: cut handling time by a third without more upheld complaints.',
  },
  {
    label: 'Retail',
    text: 'Larkfield Home & Garden is a 60-store retailer with an online shop. Customer service gets 25,000 contacts a month about orders, returns and product advice. We want an assistant on the website and in the app that answers product questions from our catalogue, checks order status and starts a return. Peak trading (November) is five times normal volume. Refunds over 50 pounds must go to a person. We take card payments but do not want the assistant to see card details.',
  },
  {
    label: 'Public sector',
    text: 'Marlow District Council wants to help residents find out whether they can claim council tax support, a blue badge or a bulky-waste collection. Rules are in about 400 pages of policy and change each April. Residents are often not confident online and some need plain-language or translated answers. The council cannot use a system that makes a decision about entitlement; staff make those. Data must stay in the UK and the council must publish how the tool works.',
  },
];
