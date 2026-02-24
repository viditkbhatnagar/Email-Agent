import OpenAI from "openai";
import { z } from "zod";
import type {
  ClassificationInput,
  ClassificationResult,
  BatchClassificationResult,
} from "@/types";

const BATCH_SIZE = 15;
const LOW_CONFIDENCE_THRESHOLD = 0.7;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Zod schema for validating OpenAI responses
const ClassificationItemSchema = z.object({
  emailId: z.string(),
  priority: z.number().min(1).max(5),
  category: z.enum([
    "approval",
    "reply-needed",
    "meeting",
    "fyi",
    "newsletter",
    "notification",
    "spam",
    "personal",
  ]),
  needsReply: z.boolean(),
  needsApproval: z.boolean(),
  isThreadActive: z.boolean(),
  actionItems: z.array(
    z.object({
      description: z.string(),
      dueDate: z.string().optional(),
    })
  ),
  summary: z.string(),
  confidence: z.number().min(0).max(1),
});

const BatchResponseSchema = z.object({
  classifications: z.array(ClassificationItemSchema),
});

const SYSTEM_PROMPT = `You are MailPilot AI, an expert email classification system. Your job is to analyze emails and produce structured classifications.

For each email, you must determine:

## Priority (1-5)
- **P1 (Immediate)**: Direct ask from a known person requiring action within 24 hours. Deadlines today or overdue. Approval requests that block other people. Urgent escalations. Emails containing words like "ASAP", "urgent", "blocking", "deadline today".
- **P2 (Important)**: Project updates requiring a response. Meeting invitations or changes. Financial, legal, or compliance matters. Requests with a deadline this week. Follow-ups on previously sent emails.
- **P3 (Moderate)**: CC'd on conversations where you may need to weigh in. Relevant industry newsletters. Non-urgent requests with no specific deadline. Team announcements requiring acknowledgment.
- **P4 (Low)**: FYI-only messages requiring no action. Automated notifications (CI/CD, monitoring, deployments). Receipts, order confirmations, shipping updates. Calendar reminders.
- **P5 (Noise)**: Marketing emails, promotions, sales outreach. Mass-sent newsletters you didn't subscribe to. Social media notifications. Spam or phishing attempts. Unsubscribe candidates.

## Category
Choose exactly one: "approval", "reply-needed", "meeting", "fyi", "newsletter", "notification", "spam", "personal"
- **approval**: Requests for sign-off, review, or authorization. Keywords: "please approve", "pending your approval", "sign off", DocuSign, "awaiting your review".
- **reply-needed**: Direct questions or requests requiring a response (but not approval). Keywords: "can you", "please send", "what do you think", "your thoughts?".
- **meeting**: Meeting invitations, reschedules, cancellations, agendas.
- **fyi**: Informational messages, status updates, shared documents requiring no action.
- **newsletter**: Recurring newsletters, digests, subscriptions.
- **notification**: Automated system notifications, alerts, confirmations.
- **spam**: Unsolicited marketing, promotions, phishing.
- **personal**: Personal messages, social invitations, non-work topics.

## Flags
- **needsReply**: true if the email contains a direct question to the recipient, a request for information, or an action that requires a written response.
- **needsApproval**: true if the email explicitly asks for approval, sign-off, authorization, or a go/no-go decision.
- **isThreadActive**: true if the email appears to be part of an ongoing back-and-forth conversation (e.g., "Re:" subject, references to previous messages, continuing discussion).

## Action Items
Extract concrete action items from the email. Each action item should have:
- description: A clear, actionable statement (e.g., "Review the Q3 budget proposal")
- dueDate: If a deadline is mentioned, include it in YYYY-MM-DD format. Otherwise omit.
Only include genuine action items, not general FYI information.

## Summary
Write a concise one-line summary (max 100 characters) that captures the key point of the email. Focus on what matters to the recipient: what is being asked, decided, or communicated.

## Confidence
Rate your confidence in this classification from 0.0 to 1.0. Lower confidence (< 0.7) if:
- The email is ambiguous or could fit multiple categories
- The snippet is too short to determine intent
- The email is in a language you cannot fully parse
- The subject line is generic (e.g., "Hi", "Update", "Quick question")

## Context Clues
Use these heuristics:
- Sender domain: corporate domains suggest work emails; gmail.com/outlook.com may suggest personal
- "noreply@" or "no-reply@" senders are almost always notifications (P4-P5)
- Emails with many recipients (large CC list) are usually FYI (P3-P4)
- "Re:" or "Fwd:" prefixes indicate thread activity
- Emails from automated systems (GitHub, Jira, Slack, etc.) are notifications
- Very short snippets with question marks likely need replies

## Output Format
Return a JSON object with a "classifications" array. Each element must have these exact fields:
- emailId (string): The exact emailId provided in the input
- priority (integer 1-5)
- category (string): one of the allowed values
- needsReply (boolean)
- needsApproval (boolean)
- isThreadActive (boolean)
- actionItems (array of {description: string, dueDate?: string})
- summary (string): max 100 characters
- confidence (float 0.0-1.0)

Always return exactly one classification per input email. Never skip an email.`;

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
Labels: ${email.labels.join(", ") || "none"}
Snippet: ${email.snippet || "(empty)"}`;

  if (includeBody && email.bodyText) {
    desc += `\nBody (excerpt): ${email.bodyText.slice(0, 1000)}`;
  }

  return desc;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function classifyBatch(
  emails: ClassificationInput[],
  includeBody: boolean = false
): Promise<BatchClassificationResult[]> {
  const emailDescriptions = emails
    .map((e, idx) => formatEmailForClassification(e, idx, includeBody))
    .join("\n\n");

  const userMessage = `Classify the following ${emails.length} email(s). Return a JSON object with a "classifications" array.\n\n${emailDescriptions}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("Empty response from OpenAI");

      const parsed = JSON.parse(content);
      const validated = BatchResponseSchema.parse(parsed);

      return validated.classifications.map((c) => ({
        emailId: c.emailId,
        classification: {
          priority: c.priority,
          category: c.category,
          needsReply: c.needsReply,
          needsApproval: c.needsApproval,
          isThreadActive: c.isThreadActive,
          actionItems: c.actionItems,
          summary: c.summary,
          confidence: c.confidence,
        },
      }));
    } catch (error) {
      if (error instanceof OpenAI.APIError && error.status === 429) {
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

  // Split into batches
  const batches: ClassificationInput[][] = [];
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    batches.push(emails.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    try {
      const batchResults = await classifyBatch(batch, false);

      // Separate high and low confidence results
      const lowConfidence = batchResults.filter(
        (r) => r.classification.confidence < LOW_CONFIDENCE_THRESHOLD
      );
      const highConfidence = batchResults.filter(
        (r) => r.classification.confidence >= LOW_CONFIDENCE_THRESHOLD
      );

      results.push(...highConfidence);

      if (lowConfidence.length > 0) {
        // Re-classify low confidence with body text
        const lowConfEmailIds = new Set(lowConfidence.map((r) => r.emailId));
        const lowConfEmails = batch.filter((e) =>
          lowConfEmailIds.has(e.emailId)
        );

        try {
          const reResults = await classifyBatch(lowConfEmails, true);
          results.push(...reResults);
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
