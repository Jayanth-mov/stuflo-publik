const CANVAS_OR_DEEP_ACADEMIC_INTENT =
  /\b(canvas|syllab(?:us|i)|assignments?|homework|courses?|class(?:es)?|modules?|quiz(?:zes)?|exams?|tests?|grades?|rubrics?|discussions?|announcements?|lectures?|readings?|files?|pages?|submissions?|professors?|instructors?|due|deadlines?|citations?|research|essays?|papers?|study guides?)\b/i;

const SIMPLE_MEMORY_ACTION = /^(?:please\s+)?(?:remember|forget)\b/i;
// A memory write can contain academic words without asking for evidence. Keep
// combined questions or retrieval requests on the academic tier.
const ADDITIONAL_RETRIEVAL_REQUEST = /\?|\b(?:check|look\s*up|search|find|verify|compare|confirm|tell me|when(?:'s| is| are)|what(?:'s| is| are)|how (?:does|do|many|much|long)|which)\b/i;
const SIMPLE_MEMORY_RECALL = /\b(?:what do you (?:remember|know) about|what does (?:your|my) (?:(?:current|durable|personal)\s+)*memory (?:say|contain)|(?:recall|show|list)(?: me)? (?:my )?(?:memories|preferences)|do you remember (?:my |me\b)|how long do i prefer (?:to )?study(?:ing)?)\b/i;
// Only a following command or question requires other tools. A future
// narrative such as "We will forget this after testing" is stored context.
const FOLLOW_ON_REQUEST = /(?:\b(?:and|then|also|plus)\b|[,.?!;\n])\s*(?:(?:please|(?:can|could|would|will) (?:you|we)|(?:I|we) (?:need|want|would like) (?:you )?to|I(?:'d| would) like (?:you )?to|you (?:should|must|need to)|let(?:'s| us))\s+|[-*]\s+)*(?:check|look\s*up|search|find|verify|compare|confirm|tell|add|create|make|set|arrange|plan|put|schedule|remind|move|reschedule|update|change|delete|cancel|book|forget|remember|save|write|erase|remove|clear|summarize|draft|send|when|what|how)\b/i;

const SIMPLE_CALENDAR_INTENT =
  /\b(calendar|appointment|meeting|event|remind(?:er| me)?|reschedule|availability|free time|busy|google meet)\b/i;

const SIMPLE_CONVERSATIONAL_INTENT =
  /^(?:hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening)|what(?:'s| is) (?:the )?(?:time|date)|who are you|help)\b/i;

export type StuModelTier = 'luna' | 'terra';

export function isSimpleMemoryAction(value: string, hasAttachmentContext = false): boolean {
  const message = value.trim();
  return !hasAttachmentContext && message.length <= 700 && SIMPLE_MEMORY_ACTION.test(message) &&
    !ADDITIONAL_RETRIEVAL_REQUEST.test(message) && !FOLLOW_ON_REQUEST.test(message);
}

export function isSimpleMemoryRecall(value: string, hasAttachmentContext = false): boolean {
  const message = value.trim();
  return !hasAttachmentContext && message.length <= 700 &&
    !CANVAS_OR_DEEP_ACADEMIC_INTENT.test(message) && !SIMPLE_CALENDAR_INTENT.test(message) &&
    !FOLLOW_ON_REQUEST.test(message) && SIMPLE_MEMORY_RECALL.test(message);
}

export function selectStuModelTier(input: {
  message: string;
  hasAttachmentContext?: boolean;
}): StuModelTier {
  const message = input.message.trim();
  if (input.hasAttachmentContext || message.length > 700) return 'terra';
  if (isSimpleMemoryAction(message)) return 'luna';
  if (CANVAS_OR_DEEP_ACADEMIC_INTENT.test(message)) return 'terra';
  if (isSimpleMemoryRecall(message)) return 'luna';
  if (SIMPLE_CALENDAR_INTENT.test(message)) return 'luna';
  if (message.length <= 180 && SIMPLE_CONVERSATIONAL_INTENT.test(message)) return 'luna';
  return 'terra';
}

export function modelForStuTier(
  tier: StuModelTier,
  options: { terraModel?: string; lunaModel?: string } = {},
): string {
  return tier === 'luna'
    ? options.lunaModel || 'gpt-6-luna'
    : options.terraModel || 'gpt-6-sol';
}
