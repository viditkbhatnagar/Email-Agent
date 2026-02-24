import OpenAI from "openai";
import { z } from "zod";
import { prepareEmailContent } from "@/lib/content-prep";
import type {
  ClassificationInput,
  ClassificationResult,
  BatchClassificationResult,
} from "@/types";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const MAX_INPUT_CHARS_PER_BATCH = 40000;
const BASE_BATCH_SIZE = 15;

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
      return { description: String((item as Record<string, unknown>).description), dueDate: (item as Record<string, unknown>).dueDate as string | undefined };
    }
    return { description: String(item) };
  });
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
  summary: z.string(),
  confidence: z.number().min(0).max(1),
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
- **P4 (Low)**: FYI-only messages. Automated notifications (CI/CD, monitoring). Shipping updates, order confirmations, receipts. Social media platform notifications. Routine bank alerts, payment confirmations. Security: routine 2FA codes, password resets. Travel: booking confirmations (no action needed). Feedback/survey/review requests from companies. Calendar reminders. Any email from a "noreply@" or "no-reply@" address. P4 means "might glance at."
- **P5 (Noise)**: Unsolicited marketing, spam, phishing. Mass newsletters you rarely read. Promotional emails. Unsubscribe candidates. P5 means "safe to auto-archive."

## Category
Choose exactly one: "approval", "reply-needed", "task", "meeting", "fyi", "personal", "support", "finance", "travel", "shipping", "security", "social", "notification", "newsletter", "marketing", "spam"

- **approval**: Requests for sign-off, review, or authorization FROM A REAL PERSON. Keywords: "please approve", "pending your approval", "sign off", DocuSign, "awaiting your review". NOT automated approval emails from systems.
- **reply-needed**: A REAL PERSON directly asks you a question or makes a request that requires YOUR written response. The sender must be a human (not a company, system, or noreply address). Automated emails asking for feedback, reviews, or surveys are NOT reply-needed. Distinct from "task": reply-needed means "respond to this message."
- **task**: A real person assigns you a concrete action item or task to complete. Distinct from reply-needed: "task" means "go do something" (write a report, fix a bug, prepare a document, update a spreadsheet), while "reply-needed" means "respond to this message." Look for: assignments, delegated work items, action items with deliverables.
- **meeting**: Meeting invitations, reschedules, cancellations, agendas, calendar events.
- **fyi**: Informational messages, status updates, shared documents requiring no action.
- **personal**: Personal messages from friends/family, social invitations, personal correspondence.
- **support**: Help desk and support ticket conversations, customer service replies, bug report follow-ups, service status updates. Ongoing support interactions where the user is either the requester or the agent.
- **finance**: Bills, invoices, payment confirmations, bank alerts/statements, tax documents, expense reports, financial transaction notifications. From banks, payment processors (PayPal, Stripe, Venmo), accounting systems. Uber/Lyft receipts.
- **travel**: Flight bookings/confirmations, hotel reservations, car rentals, travel itineraries, trip updates, boarding passes, check-in reminders. From airlines, hotels, Airbnb, travel booking platforms.
- **shipping**: Order confirmations, delivery tracking updates, shipping notifications, package arrival notices, return/refund status. From e-commerce platforms (Amazon, eBay) and shipping carriers (UPS, FedEx, USPS, DHL).
- **security**: Two-factor authentication codes, password reset requests, login alerts ("new sign-in detected"), security notices, account verification emails, suspicious activity warnings.
- **social**: Social media platform notifications: LinkedIn (connection requests, profile views, endorsements), Twitter/X, Facebook, Instagram, Reddit, etc. Platform-generated notifications about social activity. NOT personal messages from individuals — those are "personal" or "reply-needed."
- **notification**: Automated system notifications and alerts that do not fit a more specific category. CI/CD alerts, monitoring alerts, generic system emails. Use a more specific category (finance, social, shipping, security, marketing, travel) when one applies.
- **newsletter**: Recurring newsletters, digests, subscriptions, periodic content roundups.
- **marketing**: Legitimate marketing emails, promotions, sales, product announcements, and offers from companies you have a relationship with. Distinct from spam: marketing comes from known/opted-in senders, spam is unsolicited/phishing.
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
- LinkedIn ("notifications-noreply@linkedin.com") saying "X wants to connect" → social (NOT notification), needsReply=false, P4.
- LinkedIn "X viewed your profile" → social (NOT personal), needsReply=false, P4.
- Twitter/X "X liked your post" → social, P4-P5.
- GitHub ("notifications@github.com") issue/PR updates → notification, needsReply=false, P4.
- Any email from an address containing "noreply", "no-reply", "donotreply" → NEVER set needsReply=true.
- Company feedback/survey requests phrased as questions ("Would you like to rate...?", "How was your experience?") → These are NOT real questions from real people. notification, needsReply=false.
- Amazon/eBay shipping notifications → shipping (NOT notification), P4.
- Bank transaction alerts from noreply@chase.com → finance (NOT notification), P4.
- PayPal payment confirmations → finance, P4.
- Uber/Lyft receipts → finance, P4.
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

## Sender History
When sender history is provided:
- High email count + known relationship = established contact (trust the content more)
- First-time sender with no history = could be cold outreach or new contact (be cautious)
- Use relationship field directly if available (colleague, external, newsletter, etc.)

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
Extract concrete action items only when a real person asks you to do something specific. Do NOT extract action items from automated/marketing emails. "task" category emails should almost always have action items.

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
- summary (string): max 100 characters
- confidence (float 0.0-1.0)

Always return exactly one classification per input email. Never skip an email.`;

// ── Post-processing: catch automated senders GPT misclassifies ──

const AUTOMATED_LOCAL_PARTS = [
  "noreply", "no-reply", "do-not-reply", "donotreply",
  "marketplace-messages", "notifications", "alerts", "digest",
  "newsletter", "marketing", "promo", "mailer-daemon", "postmaster",
  "notification", "alert", "updates", "info", "support", "feedback",
  "survey", "billing", "receipts", "orders", "shipping", "auto",
  "automated", "bounce", "unsubscribe",
];

const AUTOMATED_DOMAINS = [
  "amazonses.com", "sendgrid.net", "mailchimp.com",
  "constantcontact.com", "mandrillapp.com", "mailgun.org",
];

const KEEP_CATEGORIES = new Set([
  "notification", "newsletter", "spam",
  "social", "marketing", "shipping", "security", "finance", "travel",
]);

function isAutomatedSender(fromEmail: string): boolean {
  const lower = fromEmail.toLowerCase();
  const atIdx = lower.indexOf("@");
  if (atIdx === -1) return false;

  const localPart = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);

  // Check domain-level automated senders
  if (AUTOMATED_DOMAINS.some((d) => domain.endsWith(d))) return true;

  // Check local part exact matches or prefix matches
  if (AUTOMATED_LOCAL_PARTS.some((p) => localPart === p || localPart.startsWith(p + "+") || localPart.startsWith(p + "."))) return true;

  // Check if local part contains common automated keywords
  if (/\b(noreply|no-reply|donotreply|do-not-reply)\b/.test(localPart)) return true;

  return false;
}

function postProcessClassification(
  result: BatchClassificationResult,
  senderEmail: string
): BatchClassificationResult {
  if (!isAutomatedSender(senderEmail)) return result;

  const c = { ...result.classification };
  c.needsReply = false;
  c.needsApproval = false;
  if (!KEEP_CATEGORIES.has(c.category)) {
    c.category = "notification";
  }
  if (c.priority < 4) {
    c.priority = 4;
  }
  return { emailId: result.emailId, classification: c };
}

function formatEmailForClassification(
  email: ClassificationInput,
  index: number,
  includeBody: boolean
): string {
  let desc = `--- Email ${index + 1} ---
emailId: ${email.emailId}
From: ${email.fromName ? `${email.fromName} <${email.from}>` : email.from}
To: ${email.to.join(", ")}
CC: ${email.cc.join(", ") || "none"}
Subject: ${email.subject || "(no subject)"}
Date: ${email.receivedAt.toISOString()}
Labels: ${email.labels.join(", ") || "none"}`;

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

  // Sender intelligence
  if (email.senderContext) {
    const sc = email.senderContext;
    desc += `\nSender history: ${sc.totalEmails} emails total`;
    if (sc.relationship) desc += `, relationship: ${sc.relationship}`;
    if (sc.avgResponseTime)
      desc += `, avg response time: ${sc.avgResponseTime.toFixed(1)}h`;
  }

  // Thread context
  if (email.threadContext) {
    const tc = email.threadContext;
    desc += `\nThread: ${tc.messageCount} messages, ${tc.participants.length} participants`;
    if (tc.yourRepliesExist) {
      desc += ` (you have replied in this thread)`;
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
    }
  } else {
    // First pass: smaller budget but still intelligently prepared content
    const prepared = prepareEmailContent(
      email.bodyText,
      email.bodyHtml,
      email.subject,
      800
    );
    if (prepared.text.length > 0) {
      desc += `\nContent preview:\n${prepared.text}`;
    } else {
      desc += `\nSnippet: ${email.snippet || "(empty)"}`;
    }
  }

  return desc;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Adaptive batch sizing based on content complexity
function splitIntoBatches(
  emails: ClassificationInput[],
  includeBody: boolean
): ClassificationInput[][] {
  const batches: ClassificationInput[][] = [];
  let currentBatch: ClassificationInput[] = [];
  let currentChars = 0;

  for (const email of emails) {
    const formatted = formatEmailForClassification(email, 0, includeBody);
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

function needsReclassification(result: BatchClassificationResult): boolean {
  const threshold =
    CONFIDENCE_THRESHOLDS[result.classification.category] ?? 0.7;
  return result.classification.confidence < threshold;
}

async function classifyBatch(
  emails: ClassificationInput[],
  includeBody: boolean = false
): Promise<BatchClassificationResult[]> {
  const emailDescriptions = emails
    .map((e, idx) => formatEmailForClassification(e, idx, includeBody))
    .join("\n\n");

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
          { role: "developer", content: SYSTEM_PROMPT },
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

      return validated.classifications.map((c) => {
        const result: BatchClassificationResult = {
          emailId: c.emailId,
          classification: {
            priority: c.priority,
            category: normalizeCategory(c.category),
            needsReply: c.needsReply,
            needsApproval: c.needsApproval,
            isThreadActive: c.isThreadActive,
            actionItems: normalizeActionItems(c.actionItems),
            summary: c.summary.slice(0, 200),
            confidence: c.confidence,
          },
        };
        const sender = emailBySender.get(c.emailId);
        return sender ? postProcessClassification(result, sender) : result;
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
      if (attempt === MAX_RETRIES - 1) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }

  throw new Error("Max retries exceeded for classification batch");
}

export async function classifyEmails(
  emails: ClassificationInput[]
): Promise<{
  results: BatchClassificationResult[];
  errors: { emailId: string; error: string }[];
}> {
  const results: BatchClassificationResult[] = [];
  const errors: { emailId: string; error: string }[] = [];

  // Adaptive batch sizing
  const batches = splitIntoBatches(emails, false);

  console.log(
    `[Classifier] Processing ${emails.length} emails in ${batches.length} batches`
  );

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    console.log(
      `[Classifier] Processing batch ${batchIdx + 1}/${batches.length} (${batch.length} emails)...`
    );
    try {
      const batchResults = await classifyBatch(batch, false);

      // Per-category confidence thresholds
      const lowConfidence = batchResults.filter(needsReclassification);
      const highConfidence = batchResults.filter(
        (r) => !needsReclassification(r)
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
          const reBatches = splitIntoBatches(lowConfEmails, true);
          for (const reBatch of reBatches) {
            const reResults = await classifyBatch(reBatch, true);
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
