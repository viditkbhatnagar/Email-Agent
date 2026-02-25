import OpenAI from "openai";
import { z } from "zod";
import { prepareEmailContent } from "@/lib/content-prep";
import type {
  ClassificationInput,
  ClassificationResult,
  BatchClassificationResult,
} from "@/types";

/** Options passed through from the pipeline to enrich classification context */
export interface ClassifyOptions {
  /** User's company domains (e.g. ["acme.com"]) — senders on these are "internal" */
  companyDomains?: string[];
  /** Recent user overrides to provide as few-shot correction examples */
  overrideExamples?: OverrideExample[];
  /** Per-category confidence threshold overrides (from self-tuning based on override rates) */
  confidenceOverrides?: Record<string, number>;
}

export interface OverrideExample {
  from: string;
  subject: string;
  /** What GPT originally classified it as */
  originalPriority: number;
  originalCategory: string;
  /** What the user corrected it to */
  correctedPriority?: number;
  correctedCategory?: string;
  correctedNeedsReply?: boolean;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const MAX_INPUT_CHARS_PER_BATCH = 50000;
const BASE_BATCH_SIZE = 12;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Map non-standard categories to allowed values
const ALLOWED_CATEGORIES = [
  "approval", "reply-needed", "task", "meeting", "fyi",
  "personal", "support", "finance", "travel", "shipping",
  "security", "social", "notification", "newsletter",
  "marketing", "spam",
] as const;

const CATEGORY_MAP: Record<string, typeof ALLOWED_CATEGORIES[number]> = {
  // Direct category matches (all 16)
  "approval": "approval",
  "reply-needed": "reply-needed",
  "reply_needed": "reply-needed",
  "reply needed": "reply-needed",
  "task": "task",
  "meeting": "meeting",
  "fyi": "fyi",
  "personal": "personal",
  "support": "support",
  "finance": "finance",
  "travel": "travel",
  "shipping": "shipping",
  "security": "security",
  "social": "social",
  "notification": "notification",
  "newsletter": "newsletter",
  "marketing": "marketing",
  "spam": "spam",

  // Task aliases
  "action-required": "task",
  "action_required": "task",
  "assignment": "task",
  "todo": "task",
  "to-do": "task",

  // Reply-needed aliases
  "question": "reply-needed",
  "request": "reply-needed",

  // Finance aliases
  "financial": "finance",
  "receipt": "finance",
  "invoice": "finance",
  "billing": "finance",
  "payment": "finance",
  "bank": "finance",
  "tax": "finance",

  // Marketing aliases
  "promotion": "marketing",
  "promo": "marketing",
  "offer": "marketing",
  "deal": "marketing",
  "sale": "marketing",

  // Social aliases
  "social-media": "social",
  "linkedin": "social",
  "twitter": "social",
  "facebook": "social",
  "instagram": "social",

  // Shipping aliases
  "delivery": "shipping",
  "tracking": "shipping",
  "order": "shipping",
  "shipment": "shipping",

  // Security aliases
  "2fa": "security",
  "mfa": "security",
  "password": "security",
  "login-alert": "security",
  "verification": "security",

  // Travel aliases
  "flight": "travel",
  "hotel": "travel",
  "booking": "travel",
  "itinerary": "travel",
  "trip": "travel",
  "reservation": "travel",

  // Support aliases
  "helpdesk": "support",
  "ticket": "support",
  "customer-service": "support",

  // Meeting aliases
  "calendar": "meeting",
  "invitation": "meeting",

  // Notification aliases
  "alert": "notification",
  "reminder": "notification",
  "automated": "notification",
  "system": "notification",
  "transactional": "notification",

  // FYI aliases
  "update": "fyi",
  "updates": "fyi",

  // Newsletter aliases
  "digest": "newsletter",
  "subscription": "newsletter",
};

function normalizeCategory(raw: string): typeof ALLOWED_CATEGORIES[number] {
  const lower = raw.toLowerCase().trim();
  return CATEGORY_MAP[lower] ?? "fyi";
}

// Normalize action items (model sometimes returns strings instead of objects)
function normalizeActionItems(items: unknown): { description: string; dueDate?: string }[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (typeof item === "string") return { description: item };
    if (typeof item === "object" && item !== null && "description" in item) {
      const raw = item as Record<string, unknown>;
      return {
        description: String(raw.description),
        dueDate: validateDateString(raw.dueDate as string | undefined, undefined),
      };
    }
    return { description: String(item) };
  });
}

/**
 * Validate a date string from GPT output.
 * Returns the date string if valid, or undefined if:
 * - Not a valid ISO date
 * - More than 7 days before the email's receivedAt (allows "bill was due yesterday")
 * - More than 1 year in the future (likely a parsing error — copyright footers, etc.)
 */
function validateDateString(
  dateStr: string | undefined | null,
  emailReceivedAt: Date | undefined
): string | undefined {
  if (!dateStr) return undefined;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return undefined;

  const now = new Date();
  const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  if (d > oneYearFromNow) return undefined;

  if (emailReceivedAt) {
    const sevenDaysBefore = new Date(emailReceivedAt.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (d < sevenDaysBefore) return undefined;
  }

  return dateStr;
}

// Lenient Zod schema that accepts raw model output, then we normalize
const RawClassificationItemSchema = z.object({
  emailId: z.string(),
  priority: z.number().min(1).max(5),
  category: z.string(),
  needsReply: z.boolean(),
  needsApproval: z.boolean(),
  isThreadActive: z.boolean(),
  actionItems: z.unknown().default([]),
  deadline: z.string().nullable().optional().default(null),
  summary: z.string(),
  confidence: z.number().min(0).max(1),
  topics: z.array(z.string()).optional().default([]),
  sentiment: z.enum(["positive", "neutral", "negative", "urgent"]).optional().default("neutral"),
});

const BatchResponseSchema = z.object({
  classifications: z.array(RawClassificationItemSchema),
});

const SYSTEM_PROMPT = `You are MailPilot AI, an expert email classification system. Your job is to analyze emails and produce structured classifications.

For each email, you must determine:

## Priority (1-5)
Priority is determined by a combination of signals: sender relationship, deadline urgency, whether you are directly addressed, and action specificity.

- **P1 (Immediate)**: A real human directly asks YOU for something with a clear deadline within 24 hours. Approval requests that block other people. Urgent escalations from colleagues/managers. Must contain an explicit action request from a person (not a company/system). Key signal: urgency + direct action needed from you.
- **P2 (Important)**: Direct requests from real people requiring your response (no urgent deadline). Emails from your direct manager or reports. Meeting invitations. Financial or legal matters needing your attention. Follow-ups on your previous emails. Tasks assigned to you with a deadline beyond 24h.
- **P3 (Moderate)**: CC'd on conversations where you may need to weigh in. Non-urgent requests. Team announcements requiring acknowledgment. LinkedIn messages from people you know. Support tickets you are involved in.
- **P4 (Low)**: FYI-only messages. Automated notifications (CI/CD, monitoring). Shipping updates, order confirmations, receipts. Social media platform notifications. Routine bank alerts, payment confirmations (no due date / already paid). Security: routine 2FA codes, password resets. Travel: booking confirmations (no action needed). Feedback/survey/review requests from companies. Calendar reminders. Any email from a "noreply@" or "no-reply@" address. P4 means "might glance at."

**IMPORTANT: Deadline-aware priority for bills and tasks**
When an email contains a deadline (bill due date, task due date, event date), factor the deadline proximity into priority:
- Due within 2 days → P1 (immediate)
- Due within 3-6 days → P2 (important)
- Due within 7-14 days → P3 (moderate)
- Due in more than 14 days → P4 (low)
This applies to finance (bills, invoices), task (assignments with deadlines), and meeting (upcoming events). A bill due in 10 days should be P3, not P4.
- **P5 (Noise)**: Unsolicited marketing, spam, phishing. Mass newsletters you rarely read. Promotional emails. Unsubscribe candidates. P5 means "safe to auto-archive."

**VIP sender rule**: If the sender is marked [VIP sender], assign at least P2 priority unless the email is clearly automated/bulk (newsletter, marketing, notification from an automated system). A VIP sender's personal email asking you something should ALWAYS be P2 or higher.

## Category
Choose exactly one: "approval", "reply-needed", "task", "meeting", "fyi", "personal", "support", "finance", "travel", "shipping", "security", "social", "notification", "newsletter", "marketing", "spam"

- **approval**: Requests for sign-off, review, or authorization FROM A REAL PERSON. Keywords: "please approve", "pending your approval", "sign off", DocuSign, "awaiting your review". NOT automated approval emails from systems.
- **reply-needed**: A REAL PERSON directly asks you a question or makes a request that requires YOUR written response. The sender must be a human (not a company, system, or noreply address). Automated emails asking for feedback, reviews, or surveys are NOT reply-needed. Distinct from "task": reply-needed means "respond to this message."
- **task**: A real person assigns you a concrete action item or task to complete. Distinct from reply-needed: "task" means "go do something" (write a report, fix a bug, prepare a document, update a spreadsheet), while "reply-needed" means "respond to this message." Look for: assignments, delegated work items, action items with deliverables.
- **meeting**: Meeting invitations, reschedules, cancellations, agendas, calendar events.
- **fyi**: Informational messages, status updates, shared documents requiring no action.
- **personal**: Personal messages from friends/family, social invitations, personal correspondence.
- **support**: Help desk and support ticket conversations, customer service replies, bug report follow-ups, service status updates. Ongoing support interactions where the user is either the requester or the agent.
- **finance**: Bills, invoices, payment confirmations, bank alerts/statements, tax documents, expense reports, financial transaction notifications. From banks, telecom/utility providers (Airtel, Jio, Vodafone, electricity boards), payment processors (PayPal, Stripe, Venmo), accounting systems. Uber/Lyft receipts. ANY email about money owed, due dates, or payment reminders is finance — even if from a noreply/ebill address.
- **travel**: Flight bookings/confirmations, hotel reservations, car rentals, travel itineraries, trip updates, boarding passes, check-in reminders. From airlines, hotels, Airbnb, travel booking platforms.
- **shipping**: Order confirmations, delivery tracking updates, shipping notifications, package arrival notices, return/refund status. From e-commerce platforms (Amazon, eBay) and shipping carriers (UPS, FedEx, USPS, DHL).
- **security**: Two-factor authentication codes, password reset requests, login alerts ("new sign-in detected"), security notices, account verification emails, suspicious activity warnings.
- **social**: Social media platform notifications: LinkedIn (connection requests, profile views, endorsements), Twitter/X, Facebook, Instagram, Reddit, etc. Platform-generated notifications about social activity. NOT personal messages from individuals — those are "personal" or "reply-needed."
- **notification**: Automated system notifications and alerts that do not fit a more specific category. CI/CD alerts, monitoring alerts, generic system emails. Use a more specific category (finance, social, shipping, security, marketing, travel) when one applies.
- **newsletter**: Recurring editorial/curated content — digests, content roundups, articles, blog updates, industry news summaries. The primary intent is to inform or educate, not to sell. If the email reads like an article or content digest, it's a newsletter.
- **marketing**: Promotional emails with commercial intent — sales, discounts, product launches, limited-time offers, event invitations from brands. The primary intent is to drive a purchase, sign-up, or engagement action. If it has a CTA to buy/subscribe/register, it's marketing. Distinct from spam: marketing comes from known/opted-in senders, spam is unsolicited/phishing.
- **spam**: Truly unsolicited email, cold outreach from strangers, phishing attempts, scams. NOT legitimate marketing from companies the user has shopped at or subscribed to.

## CRITICAL RULES for needsReply flag
- **needsReply = true** ONLY when a REAL HUMAN PERSON directly asks you something or requests information from you. The email must contain a genuine question or request directed at you personally.
- **needsReply = false** for ALL of the following:
  - Automated emails from companies (Amazon, LinkedIn, banks, etc.)
  - Emails from noreply@/no-reply@ addresses
  - Feedback/review/survey requests from companies
  - LinkedIn connection requests or notifications
  - Order confirmations, shipping updates, receipts
  - Marketing emails, newsletters
  - System notifications (GitHub, Jira, CI/CD, etc.)
  - Any email where the "From" address is clearly a company/system, not a person

## COMMON MISTAKES — DO NOT MAKE THESE
- Amazon Marketplace ("marketplace-messages@amazon") asking "share your experience?" → notification, needsReply=false, P4.
- ANY email from *@linkedin.com (invitations@, notifications-noreply@, messages-noreply@, etc.) → social, needsReply=false, P4. The display name (e.g., "Punit Soni") is the person who triggered the notification, NOT the actual sender. The actual sender is LinkedIn's platform. LinkedIn connection requests ("I just requested to connect") are ALWAYS social, NEVER personal or reply-needed.
- Twitter/X "X liked your post" → social, P4-P5.
- GitHub ("notifications@github.com") issue/PR updates → notification, needsReply=false, P4.
- Any email from an address containing "noreply", "no-reply", "donotreply" → NEVER set needsReply=true.
- Company feedback/survey requests phrased as questions ("Would you like to rate...?", "How was your experience?") → These are NOT real questions from real people. notification, needsReply=false.
- Amazon/eBay shipping notifications → shipping (NOT notification), P4.
- Bank transaction alerts from noreply@chase.com → finance (NOT notification), P4.
- PayPal payment confirmations → finance, P4.
- Uber/Lyft receipts → finance, P4.
- Airtel/Jio/Vodafone bills from ebill@airtel.com or similar → finance (NOT notification). Extract the due date as deadline.
- Electricity/water/gas utility bills → finance. Extract due date as deadline.
- Credit card statements with payment due date → finance. Extract due date as deadline.
- "Your bill is due on March 6" → finance, deadline: "2026-03-06". Priority depends on how far away the due date is.
- Promotional email from a store you have shopped at → marketing (NOT spam), P5.
- Cold outreach from a stranger selling something → spam (NOT marketing), P5.
- "Your password was reset" from noreply@service.com → security, P4.
- 2FA codes → security, P3-P4 (time-sensitive but automated).
- Flight confirmation from airline → travel, P4.
- "Your Jira ticket was updated" → support (NOT notification), P4.
- Boss says "Can you prepare the Q4 report by Friday?" → task (NOT reply-needed), P2.
- Colleague asks "What time works for you?" → reply-needed (NOT task), P2-P3.

## Flags
- **needsReply**: See CRITICAL RULES above. Default to false unless clearly from a real person with a real question.
- **needsApproval**: true ONLY if the email explicitly asks for your approval, sign-off, authorization, or a go/no-go decision. This should be rare.
- **isThreadActive**: true if the email is part of an ongoing back-and-forth conversation (e.g., "Re:" subject with multiple participants exchanging messages).

## Thread Context
When thread information is provided:
- Use "Thread: N messages, M participants" to assess whether this is an active conversation
- If "you have replied in this thread" is present, the user is already engaged — this raises priority for new messages in the thread
- Use "Recent thread messages" to understand conversation flow and determine if the latest email is a follow-up, escalation, or resolution
- Set isThreadActive=true when the thread has multiple recent messages from different participants (back-and-forth pattern)

## Attachments
When attachment metadata is provided:
- PDFs, DOCx, spreadsheets suggest documents for review (may indicate approval/fyi)
- Calendar .ics files reinforce "meeting" category
- Large number of attachments or .zip files may indicate a deliverable
- Images alone (png, jpg) in marketing emails are decoration — do not elevate priority

## Directly Addressed Signal
When "Directly addressed: no (CC only)" is present:
- The user is CC'd, not the primary recipient. This is almost always P3 or lower.
- Only escalate above P3 if the email body explicitly mentions the user by name or role.
- CC'd on a conversation = typically "fyi" or "notification" category.
- Exception: if the user has been replying in the thread, treat as engaged participant.

## Mailing List Signal
When "Mailing list: yes" is present:
- This email was sent to a distribution list, not personally addressed.
- Category is typically newsletter, marketing, notification, or fyi.
- Priority P4-P5 unless the email contains a deadline relevant to the user (e.g., a bill sent via mailing list).
- NEVER set needsReply=true for mailing list emails.

## Follow-up & Escalation Signals
When "Follow-up detected: yes" is present:
- The sender is re-requesting something they previously asked for. Escalate priority by 1 level from what you would normally assign (e.g., if you'd assign P3, make it P2).
When "Escalation detected: yes" is present:
- The email contains urgency language (urgent, ASAP, critical, blocking, action required). Escalate priority by 2 levels (e.g., P4→P2). Use P1 only if the escalation is from a real person with a concrete request.

## Sender Velocity
When sender's recent email count shows "UNUSUAL — significantly above normal frequency":
- This sender is emailing much more than their historical average, which suggests urgency or an ongoing situation.
- Factor this into priority — consider bumping priority by 1 level.
- Check if the content explains the surge (e.g., ongoing thread, incident, deadline).

## Sender History
When sender history is provided:
- High email count + known relationship = established contact (trust the content more)
- First-time sender with no history = could be cold outreach or new contact (be cautious)
- Use relationship field directly if available (colleague, internal, newsletter, automated, etc.)
- [VIP sender] = user has marked this sender as important — treat their emails as at least P2

## Forwarded Emails
When an email is marked as forwarded:
- The sender forwarded someone else's email — analyze BOTH the forwarder's comment and the original message
- The forwarder may be asking for your opinion or action on the forwarded content
- Category should reflect what the FORWARDER wants from you, not the original email's intent

## Reply Chain Handling
When parsed reply chain content is provided:
- Focus primarily on the NEWEST message (the primary content)
- Use the reply chain for CONTEXT only — it helps understand what is being discussed
- If the newest message is short (e.g., "Approved", "Thanks", "Sounds good"), the chain is essential for understanding intent

## Action Items
Extract action items for ANY email that requires user action. Do NOT extract action items from automated/marketing/spam emails. Include dueDate (ISO format) when extractable.
- **task**: Deliverables, assignments — always extract action items.
- **approval**: Extract the decision needed (e.g., "approve/reject budget proposal").
- **reply-needed**: Extract what the sender is asking (e.g., "respond with availability").
- **meeting**: Extract preparation items (e.g., "RSVP by Friday", "prepare Q4 slides for meeting").

## Deadline
Extract the earliest actionable deadline from the email as an ISO 8601 date string (YYYY-MM-DD), or null if none exists. Look for:
- Bill/payment due dates ("due on March 6", "payment due by 2026-03-06")
- Task deadlines ("by Friday", "before end of day March 10")
- Event dates that require preparation ("meeting on March 15" → deadline is the meeting date)
- Expiration dates ("offer expires March 1", "link valid until March 5")
- RSVP deadlines
Do NOT extract dates that are purely informational (e.g., "your order was placed on Feb 20" — that's a past date, not a deadline).
If multiple deadlines exist, use the EARLIEST one that requires action.

## Recipient Count Signal
When "Recipients: N" is provided:
- 1-2 recipients = direct/personal communication. Likely higher priority.
- 3-5 recipients = small group discussion. Moderate priority.
- 6-10 recipients = team-wide email. Usually P3-P4 unless deadline-relevant.
- >10 recipients = mass email / distribution list. Almost certainly P4-P5 unless deadline-relevant.
- Never set needsReply=true for emails with >10 recipients unless your name is explicitly called out in the body.

## Provider Flags (Starred/Important)
When "Provider flags: STARRED" or "Provider flags: IMPORTANT" is present:
- The user has marked this email as starred or important in their email client. This is a direct user importance signal.
- Ensure priority is at least P2 unless the email is clearly automated/bulk (newsletter, marketing, spam).
- Starred emails from noreply senders can remain P4 if the content is routine.

## Reply-to-Your-Email Signal
When "This is a REPLY to YOUR email" is present:
- This person is responding to something the user sent. The user was waiting for this response.
- Elevate priority by 1 level from what you would normally assign.
- Consider needsReply=true if the reply contains a follow-up question.
- This is a strong engagement signal — the user initiated this conversation.

## Thread Fatigue Signal
When "Thread fatigue: yes" is present (high message count + user hasn't replied recently):
- The user appears to have disengaged from this conversation.
- Do NOT elevate priority based on thread activity alone.
- Classify based on the content of the NEW message only.
- If the new message doesn't directly request action from the user, assign P3-P4.

## Topics
Extract 1-3 short topic tags that describe what this email is about. Use lowercase, hyphen-separated tags.
Examples: "project-alpha", "q4-report", "billing", "hiring", "server-outage", "design-review"
Keep tags specific enough to be useful for search but general enough to group related emails.

## Sentiment
Assess the overall tone of the email: "positive", "neutral", "negative", or "urgent".
- positive: good news, thanks, congratulations, approvals
- neutral: routine, informational, standard requests
- negative: complaints, problems, disappointment, rejection
- urgent: time pressure, crisis, blocking issues (distinct from escalation detection — this is about tone)

## Summary
Write a concise one-line summary (max 100 characters) that captures the key point of the email.

## Confidence
Rate 0.0 to 1.0. Lower confidence (< 0.7) if ambiguous or content too short.

## IMPORTANT: emailId handling
The emailId for each email is provided in the input. You MUST return the EXACT same emailId string in your output. Do not modify, truncate, or alter the emailId in any way. Copy it character-by-character.

## Output Format
Return a JSON object with a "classifications" array. Each element must have these exact fields:
- emailId (string): The EXACT emailId from the input — copy it character-by-character
- priority (integer 1-5)
- category (string): one of "approval", "reply-needed", "task", "meeting", "fyi", "personal", "support", "finance", "travel", "shipping", "security", "social", "notification", "newsletter", "marketing", "spam"
- needsReply (boolean)
- needsApproval (boolean)
- isThreadActive (boolean)
- actionItems (array of {description: string, dueDate?: string})
- deadline (string|null): ISO 8601 date (YYYY-MM-DD) of the earliest actionable deadline, or null if none
- summary (string): max 100 characters
- confidence (float 0.0-1.0)
- topics (array of strings): 1-3 short topic tags (lowercase, hyphen-separated)
- sentiment (string): one of "positive", "neutral", "negative", "urgent"

Always return exactly one classification per input email. Never skip an email.`;

// ── Post-processing: enforce flags for noreply senders ──
//
// Previous approach was too aggressive: a broad list of "automated" local parts
// (info, support, billing, orders, etc.) matched most legitimate senders, and
// then forcibly floored priority to P4. This caused nearly everything to show
// as P4/P5. The fix: narrow detection to only truly non-human addresses and
// only enforce flag overrides — never touch priority or category (trust GPT).

// Addresses where the sender is definitively non-human.
// Since we ONLY enforce needsReply=false (no priority/category changes),
// it's safe to be broad here — the worst case is needsReply=false for
// a human sender at an unusual address, which is very rare.
const NOREPLY_LOCAL_PARTS = [
  // Cannot reply
  "noreply", "no-reply", "do-not-reply", "donotreply",
  "mailer-daemon", "postmaster", "bounce",
  // Platform notification senders — no human behind these
  "invitations", "notifications", "notification",
  "alerts", "alert", "digest", "newsletter",
  "marketing", "promo", "automated", "auto",
  "unsubscribe", "marketplace-messages",
];

// Delivery platform domains — rare in From header, but definitively automated
const AUTOMATED_DOMAINS = [
  "amazonses.com", "sendgrid.net", "mailchimp.com",
  "constantcontact.com", "mandrillapp.com", "mailgun.org",
];

function isNoreplySender(fromEmail: string): boolean {
  const lower = fromEmail.toLowerCase();
  const atIdx = lower.indexOf("@");
  if (atIdx === -1) return false;

  const localPart = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);

  // Check delivery platform domains
  if (AUTOMATED_DOMAINS.some((d) => domain.endsWith(d))) return true;

  // Check noreply patterns — exact match or with + / . separators
  if (NOREPLY_LOCAL_PARTS.some((p) => localPart === p || localPart.startsWith(p + "+") || localPart.startsWith(p + "."))) return true;

  // Check if local part contains noreply keywords anywhere
  if (/\b(noreply|no-reply|donotreply|do-not-reply)\b/.test(localPart)) return true;

  return false;
}

function postProcessClassification(
  result: BatchClassificationResult,
  senderEmail: string,
  companyDomains?: string[]
): BatchClassificationResult {
  // Skip noreply override for company domain senders (e.g., marketing@yourcompany.com)
  if (companyDomains?.length) {
    const senderDomain = senderEmail.toLowerCase().split("@")[1] ?? "";
    const isInternal = companyDomains.some((d) => {
      const dl = d.toLowerCase();
      return senderDomain === dl || senderDomain.endsWith("." + dl);
    });
    if (isInternal) return result;
  }
  if (!isNoreplySender(senderEmail)) return result;

  // For noreply senders: only enforce flag overrides.
  // Priority and category are left to GPT — a fraud alert from noreply@bank.com
  // could legitimately be P2, and GPT's 16-category system with the detailed
  // system prompt handles categorization better than keyword overrides.
  const c = { ...result.classification };
  c.needsReply = false;
  c.needsApproval = false;
  return { emailId: result.emailId, classification: c };
}

// ── B3: Regex-based deadline extraction as cross-check ──

const DEADLINE_PATTERNS: { regex: RegExp; group: number }[] = [
  // "due by March 15" / "due on 3/15/2026" / "due before March 15, 2026"
  { regex: /\bdue\s+(?:by|on|before)\s+(\w+\s+\d{1,2}(?:,?\s+\d{4})?)/i, group: 1 },
  // "deadline: March 15" / "deadline is March 15"
  { regex: /\bdeadline[:\s]+(?:is\s+)?(\w+\s+\d{1,2}(?:,?\s+\d{4})?)/i, group: 1 },
  // "expires March 15" / "expires on 3/15"
  { regex: /\bexpires?\s+(?:on\s+)?(\w+\s+\d{1,2}(?:,?\s+\d{4})?)/i, group: 1 },
  // "payment due 03/15/2026" / "payment due 2026-03-15"
  { regex: /\bpayment\s+due\s+(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i, group: 1 },
  // ISO dates: "2026-03-15"
  { regex: /\b(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/, group: 1 },
  // US dates: "03/15/2026" or "3/15/26"
  { regex: /\b((?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/(?:20)?\d{2})\b/, group: 1 },
  // "by Friday" / "by Monday" / "by end of day" / "by EOD" / "by COB"
  { regex: /\bby\s+((?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|end\s+of\s+(?:day|week|month)|eod|cob|tomorrow|tonight))/i, group: 1 },
  // "within 24 hours" / "within 48 hours" / "within 2 days"
  { regex: /\bwithin\s+(\d+\s+(?:hours?|days?|business\s+days?))/i, group: 1 },
  // "RSVP by March 15"
  { regex: /\brsvp\s+(?:by|before)\s+(\w+\s+\d{1,2}(?:,?\s+\d{4})?)/i, group: 1 },
];

/**
 * Extract potential deadline-like dates from email text using regex.
 * Returns raw matched strings (not necessarily valid ISO dates).
 * Used as a cross-check: if GPT misses a deadline but regex finds one, force second pass.
 */
function extractDatesFromText(text: string): string[] {
  const found: string[] = [];
  const cleanText = text.slice(0, 3000); // Limit scan length
  for (const { regex, group } of DEADLINE_PATTERNS) {
    const match = cleanText.match(regex);
    if (match && match[group]) {
      found.push(match[group].trim());
    }
  }
  return [...new Set(found)];
}

// ── C1: Rule-based classification fallback (when GPT is unavailable) ──

function classifyWithRules(email: ClassificationInput): ClassificationResult {
  const fromLower = email.from.toLowerCase();
  const subjectLower = email.subject.toLowerCase();
  const isNoreply = isNoreplySender(email.from);
  const isStarred = email.labels.includes("STARRED") || email.labels.includes("IMPORTANT");

  let category = "fyi";
  let priority = 4;
  let needsReply = false;
  const needsApproval = false;

  // Mailing list + noreply → newsletter
  if (email.isMailingList && isNoreply) {
    category = "newsletter";
    priority = 5;
  }
  // Noreply with shipping keywords
  else if (isNoreply && /\b(order|shipped|delivered|tracking|shipment|package)\b/i.test(subjectLower)) {
    category = "shipping";
    priority = 4;
  }
  // Noreply with finance keywords
  else if (isNoreply && /\b(receipt|payment|invoice|bill|statement|transaction|refund)\b/i.test(subjectLower)) {
    category = "finance";
    priority = 4;
  }
  // Noreply with security keywords
  else if (isNoreply && /\b(password|verification|2fa|security|login|sign.?in|authenticate)\b/i.test(subjectLower)) {
    category = "security";
    priority = 4;
  }
  // .ics attachment → meeting
  else if (email.attachments?.some((a) => a.mimeType === "text/calendar" || a.filename.endsWith(".ics"))) {
    category = "meeting";
    priority = 3;
  }
  // Mailing list → newsletter
  else if (email.isMailingList) {
    category = "newsletter";
    priority = 4;
  }
  // Noreply → notification
  else if (isNoreply) {
    category = "notification";
    priority = 4;
  }
  // Social media platforms
  else if (/\b(linkedin|twitter|facebook|instagram)\b/i.test(fromLower)) {
    category = "social";
    priority = 4;
  }
  // Re: subject with non-noreply sender → likely needs attention
  else if (/^re:/i.test(email.subject) && !isNoreply) {
    category = "reply-needed";
    priority = 3;
    needsReply = true;
  }
  // Fwd: subject → fyi
  else if (/^(fwd?|fw):/i.test(email.subject)) {
    category = "fyi";
    priority = 3;
  }

  // Starred boost
  if (isStarred && priority > 2) {
    priority = 2;
  }

  return {
    priority,
    category,
    needsReply,
    needsApproval,
    isThreadActive: false,
    actionItems: [],
    deadline: null,
    summary: email.subject.slice(0, 100) || "(no subject)",
    confidence: 0.3, // Low confidence — rule-based fallback
    topics: [],
    sentiment: "neutral",
  };
}

function formatEmailForClassification(
  email: ClassificationInput,
  index: number,
  includeBody: boolean,
  options?: ClassifyOptions
): string {
  let desc = `--- Email ${index + 1} ---
emailId: ${email.emailId}
From: ${email.fromName ? `${email.fromName} <${email.from}>` : email.from}
To: ${email.to.join(", ")}
CC: ${email.cc.join(", ") || "none"}
Subject: ${email.subject || "(no subject)"}
Date: ${email.receivedAt.toISOString()}
Labels: ${email.labels.join(", ") || "none"}`;

  // Domain intelligence — internal vs external sender
  if (options?.companyDomains && options.companyDomains.length > 0) {
    const senderDomain = email.from.split("@")[1]?.toLowerCase();
    const isInternal = senderDomain
      ? options.companyDomains.some((d) => {
          const dl = d.toLowerCase();
          return senderDomain === dl || senderDomain.endsWith("." + dl);
        })
      : false;
    desc += `\nSender is: ${isInternal ? "internal (colleague)" : "external"}`;
  }

  // Attachment metadata
  if (email.hasAttachments) {
    if (email.attachments && email.attachments.length > 0) {
      const fileList = email.attachments
        .map((a) => `${a.filename} (${a.mimeType})`)
        .join(", ");
      desc += `\nAttachments: ${fileList}`;
    } else {
      desc += `\nAttachments: yes (details unavailable)`;
    }
  }

  // Forwarded detection
  if (email.isForwarded) {
    desc += `\nForwarded: yes`;
  }

  // Recipient count signal
  if (email.recipientCount != null) {
    desc += `\nRecipients: ${email.recipientCount}`;
  } else {
    const totalRecipients = email.to.length + email.cc.length;
    desc += `\nRecipients: ${totalRecipients}`;
  }

  // Provider flags (starred/important)
  const providerFlags: string[] = [];
  if (email.labels.includes("STARRED")) providerFlags.push("STARRED");
  if (email.labels.includes("IMPORTANT")) providerFlags.push("IMPORTANT");
  if (providerFlags.length > 0) {
    desc += `\nProvider flags: ${providerFlags.join(", ")}`;
  }

  // Enrichment signals
  desc += `\nDirectly addressed: ${email.isDirectlyAddressed !== false ? "yes" : "no (CC only)"}`;
  if (email.isMailingList) {
    desc += `\nMailing list: yes`;
  }
  if (email.isFollowUp) {
    desc += `\nFollow-up detected: yes`;
  }
  if (email.isEscalation) {
    desc += `\nEscalation detected: yes`;
  }

  // Sender intelligence
  if (email.senderContext) {
    const sc = email.senderContext;
    desc += `\nSender history: ${sc.totalEmails} emails total`;
    if (sc.relationship) desc += `, relationship: ${sc.relationship}`;
    if (sc.avgResponseTime)
      desc += `, avg response time: ${sc.avgResponseTime.toFixed(1)}h`;
    if (sc.recentEmailCount != null && sc.recentEmailCount > 0) {
      desc += `, ${sc.recentEmailCount} emails this week`;
      // Flag velocity anomaly if significantly above average
      const avgPerWeek = sc.totalEmails > 4 ? sc.totalEmails / 4 : sc.totalEmails;
      if (sc.recentEmailCount > avgPerWeek * 3) {
        desc += ` (UNUSUAL — significantly above normal frequency)`;
      }
    }
    if (sc.isVip) desc += ` [VIP sender]`;
  }

  // Thread context
  if (email.threadContext) {
    const tc = email.threadContext;
    desc += `\nThread: ${tc.messageCount} messages, ${tc.participants.length} participants`;
    if (tc.yourRepliesExist) {
      desc += ` (you have replied in this thread)`;
    }
    if (tc.isReplyToYou) {
      desc += `\nThis is a REPLY to YOUR email — you were waiting for this response`;
    }
    if (tc.threadFatigueDetected) {
      desc += `\nThread fatigue: yes (${tc.messageCount} messages, you haven't replied recently)`;
    }
    if (tc.latestMessages.length > 0) {
      desc += `\nRecent thread messages:`;
      for (const m of tc.latestMessages) {
        desc += `\n  - ${m.fromName || m.from} (${m.receivedAt.toISOString()}): ${m.snippet?.slice(0, 120) || "(no snippet)"}`;
      }
    }
  }

  // Body content — use intelligent content preparation
  if (includeBody) {
    const prepared = prepareEmailContent(
      email.bodyText,
      email.bodyHtml,
      email.subject,
      3000
    );
    if (prepared.text.length > 0) {
      desc += `\nBody:\n${prepared.text}`;
      if (prepared.meta.hadReplyChain) {
        desc += `\n[Reply chain depth: ${prepared.meta.replyChainDepth}]`;
      }
      if (prepared.meta.wasForwarded) {
        desc += `\n[Content was forwarded]`;
      }
      if (prepared.meta.hadSignature) {
        desc += `\n[Signature stripped — real person sender]`;
      }
    }
  } else {
    // First pass: moderate budget — enough to capture due dates, key details
    const prepared = prepareEmailContent(
      email.bodyText,
      email.bodyHtml,
      email.subject,
      1800
    );
    if (prepared.text.length > 0) {
      desc += `\nContent preview:\n${prepared.text}`;
      if (prepared.meta.wasForwarded) {
        desc += `\n[Content was forwarded]`;
      }
      if (prepared.meta.hadSignature) {
        desc += `\n[Signature stripped — real person sender]`;
      }
    } else {
      desc += `\nSnippet: ${email.snippet || "(empty)"}`;
    }
  }

  // Regex date cross-check: surface detected dates as hints for GPT
  const textForDates = email.bodyText || email.snippet || "";
  const detectedDates = extractDatesFromText(textForDates);
  if (detectedDates.length > 0) {
    desc += `\nDetected dates in body: [${detectedDates.join(", ")}]`;
  }

  return desc;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Adaptive batch sizing based on content complexity
function splitIntoBatches(
  emails: ClassificationInput[],
  includeBody: boolean,
  options?: ClassifyOptions
): ClassificationInput[][] {
  const batches: ClassificationInput[][] = [];
  let currentBatch: ClassificationInput[] = [];
  let currentChars = 0;

  for (const email of emails) {
    const formatted = formatEmailForClassification(email, 0, includeBody, options);
    const emailChars = formatted.length;

    if (
      currentBatch.length > 0 &&
      (currentChars + emailChars > MAX_INPUT_CHARS_PER_BATCH ||
        currentBatch.length >= BASE_BATCH_SIZE)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(email);
    currentChars += emailChars;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

// Per-category confidence thresholds
const CONFIDENCE_THRESHOLDS: Record<string, number> = {
  // Low-stakes: easy to identify, low cost if wrong
  "spam": 0.6,
  "newsletter": 0.6,
  "marketing": 0.6,
  "social": 0.6,
  "shipping": 0.6,
  "notification": 0.6,
  // Medium-stakes
  "meeting": 0.65,
  "travel": 0.65,
  "finance": 0.7,
  "security": 0.7,
  "personal": 0.7,
  "support": 0.7,
  // High-stakes: misclassification has real consequences
  "fyi": 0.75,
  "task": 0.75,
  "reply-needed": 0.80,
  "approval": 0.8,
};

// High-stakes categories always get second pass unless very confident
const HIGH_STAKES_CATEGORIES = new Set(["approval", "reply-needed", "task"]);

function needsReclassification(
  result: BatchClassificationResult,
  confidenceOverrides?: Record<string, number>,
  originalEmail?: ClassificationInput
): boolean {
  const category = result.classification.category;
  const confidence = result.classification.confidence;

  // High-stakes categories: force second pass unless confidence >= 0.90
  if (HIGH_STAKES_CATEGORIES.has(category) && confidence < 0.9) {
    return true;
  }

  // B3: If GPT returned no deadline but regex found dates, force second pass
  // (GPT may have missed deadline info due to content truncation on first pass)
  if (!result.classification.deadline && originalEmail) {
    const textForDates = originalEmail.bodyText || originalEmail.snippet || "";
    const regexDates = extractDatesFromText(textForDates);
    if (regexDates.length > 0) {
      return true;
    }
  }

  // Dynamic threshold: use override-based threshold if available, else static default
  const threshold =
    confidenceOverrides?.[category] ??
    CONFIDENCE_THRESHOLDS[category] ??
    0.7;
  return confidence < threshold;
}

async function classifyBatch(
  emails: ClassificationInput[],
  includeBody: boolean = false,
  options?: ClassifyOptions
): Promise<BatchClassificationResult[]> {
  const emailDescriptions = emails
    .map((e, idx) => formatEmailForClassification(e, idx, includeBody, options))
    .join("\n\n");

  // Build system prompt — append override examples if available
  let systemPrompt = SYSTEM_PROMPT;
  if (options?.overrideExamples && options.overrideExamples.length > 0) {
    // Group overrides by sender pattern for concise summary
    const senderGroups = new Map<string, typeof options.overrideExamples>();
    for (const ex of options.overrideExamples) {
      const key = ex.from.toLowerCase();
      const arr = senderGroups.get(key) || [];
      arr.push(ex);
      senderGroups.set(key, arr);
    }

    let correctionText = "";

    // First: summarize grouped patterns (e.g., "User corrected 5 emails from X to category Y")
    for (const [sender, exs] of senderGroups) {
      if (exs.length >= 2) {
        // Check if there's a dominant correction pattern
        const categoryCorrections = new Map<string, number>();
        for (const ex of exs) {
          if (ex.correctedCategory) {
            categoryCorrections.set(
              ex.correctedCategory,
              (categoryCorrections.get(ex.correctedCategory) ?? 0) + 1
            );
          }
        }
        for (const [cat, count] of categoryCorrections) {
          if (count >= 2) {
            correctionText += `  - PATTERN: User corrected ${count} emails from "${sender}" to category "${cat}". Apply this pattern to similar emails from this sender.\n`;
          }
        }
      }
    }

    // Then: individual examples (up to 20)
    const examples = options.overrideExamples
      .slice(0, 20)
      .map((ex) => {
        const parts: string[] = [
          `  - From: ${ex.from}, Subject: "${ex.subject}"`,
          `    GPT classified: P${ex.originalPriority}/${ex.originalCategory}`,
        ];
        const corrections: string[] = [];
        if (ex.correctedPriority !== undefined)
          corrections.push(`P${ex.correctedPriority}`);
        if (ex.correctedCategory)
          corrections.push(ex.correctedCategory);
        if (ex.correctedNeedsReply !== undefined)
          corrections.push(`needsReply=${ex.correctedNeedsReply}`);
        parts.push(`    User corrected to: ${corrections.join(", ")}`);
        return parts.join("\n");
      })
      .join("\n");

    systemPrompt += `\n\n## User Correction History\nThe user has previously corrected the following classifications. Learn from these patterns and adjust your classifications accordingly. Pay special attention to PATTERN entries — they represent repeated corrections.\n${correctionText}${examples}`;
  }

  const userMessage = `Classify the following ${emails.length} email(s). Return a JSON object with a "classifications" array.\n\n${emailDescriptions}`;

  // Dynamic token calculation
  const estimatedOutputTokens = Math.min(
    emails.length * 250 + 500,
    8192
  );

  console.log(
    `[Classifier] Sending batch of ${emails.length} emails to GPT-5.2 (includeBody=${includeBody})...`
  );

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      console.log(`[Classifier] Attempt ${attempt + 1}/${MAX_RETRIES}...`);

      // GPT-5.2 Responses API
      const response = await openai.responses.create({
        model: "gpt-5.2",
        reasoning: { effort: "high" },
        input: [
          { role: "developer", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        text: { format: { type: "json_object" } },
        max_output_tokens: estimatedOutputTokens,
      });

      // Parse response from Responses API structure
      const outputMessage = response.output.find(
        (o) => o.type === "message"
      );
      if (!outputMessage || outputMessage.type !== "message") {
        throw new Error("No message output from GPT-5.2");
      }

      const textContent = outputMessage.content.find(
        (c) => c.type === "output_text"
      );
      if (!textContent || textContent.type !== "output_text") {
        throw new Error("No text content in GPT-5.2 response");
      }

      const content = textContent.text;
      if (!content) throw new Error("Empty response from GPT-5.2");

      const parsed = JSON.parse(content);
      const validated = BatchResponseSchema.parse(parsed);

      console.log(
        `[Classifier] Batch classified ${validated.classifications.length} emails`
      );

      const emailBySender = new Map(emails.map((e) => [e.emailId, e.from]));
      const emailByReceivedAt = new Map(emails.map((e) => [e.emailId, e.receivedAt]));

      return validated.classifications.map((c) => {
        const receivedAt = emailByReceivedAt.get(c.emailId);
        const validatedDeadline = validateDateString(c.deadline, receivedAt);
        const result: BatchClassificationResult = {
          emailId: c.emailId,
          classification: {
            priority: c.priority,
            category: normalizeCategory(c.category),
            needsReply: c.needsReply,
            needsApproval: c.needsApproval,
            isThreadActive: c.isThreadActive,
            actionItems: normalizeActionItems(c.actionItems),
            deadline: validatedDeadline ?? null,
            summary: c.summary.slice(0, 200),
            confidence: c.confidence,
            topics: (c.topics ?? []).slice(0, 3).map((t: string) => t.toLowerCase().trim()),
            sentiment: c.sentiment ?? "neutral",
          },
        };
        const sender = emailBySender.get(c.emailId);
        return sender ? postProcessClassification(result, sender, options?.companyDomains) : result;
      });
    } catch (error) {
      console.error(
        `[Classifier] Attempt ${attempt + 1} failed:`,
        error instanceof Error ? error.message : error
      );
      if (error instanceof OpenAI.APIError && error.status === 429) {
        console.log(
          `[Classifier] Rate limited, waiting ${RETRY_DELAY_MS * Math.pow(2, attempt)}ms...`
        );
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      if (attempt === MAX_RETRIES - 1) {
        // C1: Rule-based fallback — return rough classifications instead of throwing
        console.warn(
          `[Classifier] All ${MAX_RETRIES} attempts failed. Falling back to rule-based classification for ${emails.length} emails.`
        );
        return emails.map((email) => ({
          emailId: email.emailId,
          classification: classifyWithRules(email),
        }));
      }
      await sleep(RETRY_DELAY_MS);
    }
  }

  // Should never reach here, but fallback just in case
  return emails.map((email) => ({
    emailId: email.emailId,
    classification: classifyWithRules(email),
  }));
}

export async function classifyEmails(
  emails: ClassificationInput[],
  options?: ClassifyOptions
): Promise<{
  results: BatchClassificationResult[];
  errors: { emailId: string; error: string }[];
}> {
  const results: BatchClassificationResult[] = [];
  const errors: { emailId: string; error: string }[] = [];

  // Adaptive batch sizing
  const batches = splitIntoBatches(emails, false, options);

  console.log(
    `[Classifier] Processing ${emails.length} emails in ${batches.length} batches`
  );

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    console.log(
      `[Classifier] Processing batch ${batchIdx + 1}/${batches.length} (${batch.length} emails)...`
    );
    try {
      const batchResults = await classifyBatch(batch, false, options);

      // Per-category confidence thresholds (with dynamic overrides)
      const confOverrides = options?.confidenceOverrides;
      const emailById = new Map(batch.map((e) => [e.emailId, e]));
      const lowConfidence = batchResults.filter((r) =>
        needsReclassification(r, confOverrides, emailById.get(r.emailId))
      );
      const highConfidence = batchResults.filter(
        (r) => !needsReclassification(r, confOverrides, emailById.get(r.emailId))
      );

      results.push(...highConfidence);

      if (lowConfidence.length > 0) {
        // Re-classify low confidence with full body text
        const lowConfEmailIds = new Set(
          lowConfidence.map((r) => r.emailId)
        );
        const lowConfEmails = batch.filter((e) =>
          lowConfEmailIds.has(e.emailId)
        );

        console.log(
          `[Classifier] Re-classifying ${lowConfEmails.length} low-confidence emails with full body...`
        );

        try {
          // Use adaptive batching for re-classification too
          const reBatches = splitIntoBatches(lowConfEmails, true, options);
          for (const reBatch of reBatches) {
            const reResults = await classifyBatch(reBatch, true, options);
            results.push(...reResults);
          }
        } catch {
          // If re-classification fails, use original low-confidence results
          results.push(...lowConfidence);
        }
      }
    } catch (error) {
      for (const email of batch) {
        errors.push({
          emailId: email.emailId,
          error:
            error instanceof Error ? error.message : "Classification failed",
        });
      }
    }
  }

  return { results, errors };
}

export async function reclassifySingleEmail(
  email: ClassificationInput
): Promise<ClassificationResult> {
  const results = await classifyBatch([email], true);
  if (results.length === 0)
    throw new Error("No classification result returned");
  return results[0].classification;
}
