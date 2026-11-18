'use client';

import { useCallback, useState, useRef, useEffect } from 'react';
import Image from 'next/image';
import { FileText, Mic, Paperclip, Send, Square, X } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { publikLink } from '@/lib/publik';

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
const MAX_CHAT_INPUT_ROWS = 10;

type ChatAttachment = {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  file: File;
};

type UploadedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
};

type MessageAttachment = {
  name: string;
  mimeType: string;
  size: number;
  dataUrl?: string;
};

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: number;
  attachments?: MessageAttachment[];
  creditsCharged?: number | null;
  model?: string | null;
};

type SpeechRecognitionResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { transcript: string };
};

type SpeechRecognitionEventLike = Event & {
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionErrorEventLike = Event & {
  readonly error: string;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  }
}

function speechRecognitionErrorMessage(error: string) {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access was blocked. Allow microphone access in your browser and try again.';
    case 'audio-capture':
      return 'No working microphone was found.';
    case 'no-speech':
      return "StuFlo didn't hear anything. Tap the microphone and try again.";
    case 'network':
      return 'Speech recognition could not connect. Check your connection and try again.';
    default:
      return 'Speech recognition stopped unexpectedly. Please try again.';
  }
}

function microphoneStartErrorMessage(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Microphone access is blocked. Allow it for app.stuflo.com in your browser site settings, then try again.';
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return 'No working microphone was found.';
    }
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      return 'Your microphone is busy in another app. Close the other app and try again.';
    }
  }
  return 'The microphone could not start. Check your browser and system microphone permissions.';
}

function formatMessageCredits(value: number) {
  if (!Number.isFinite(value)) return '0';
  if (value < 0.01) return '<0.01';
  if (value < 1) return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return value.toFixed(1).replace(/\.0$/, '');
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

async function uploadAttachment(attachment: ChatAttachment): Promise<UploadedAttachment> {
  const response = await fetch('/api/worker/attachments', {
    method: 'POST',
    headers: {
      'Content-Type': attachment.mimeType,
      'x-stuflo-file-name': encodeURIComponent(attachment.name),
    },
    body: attachment.file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.id !== 'string') {
    throw new Error(data.message || data.error || `Could not upload ${attachment.name}.`);
  }
  return data as UploadedAttachment;
}

function isImageAttachment(attachment: MessageAttachment) {
  return attachment.mimeType.startsWith('image/') && Boolean(attachment.dataUrl);
}

function StuAvatar() {
  return (
    <div className="w-8 h-8 rounded-full overflow-hidden border border-line bg-surface shrink-0 mt-1">
      <Image
        src="/stu-avatar-light.png"
        alt="Stu"
        width={32}
        height={32}
        className="block h-full w-full object-cover dark:hidden"
        priority={false}
      />
      <Image
        src="/stu-avatar-dark.png"
        alt="Stu"
        width={32}
        height={32}
        className="hidden h-full w-full object-cover dark:block"
        priority={false}
      />
    </div>
  );
}

const markdownComponents: Components = {
  p({ children }) {
    return <p className="mb-3 last:mb-0">{children}</p>;
  },
  ul({ children }) {
    return <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>;
  },
  li({ children }) {
    return <li className="pl-1">{children}</li>;
  },
  strong({ children }) {
    return <strong className="font-bold text-fg1">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic">{children}</em>;
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="font-semibold text-primary-600 underline underline-offset-2 hover:text-primary-700"
      >
        {children}
      </a>
    );
  },
  code({ className, children }) {
    return (
      <code className={`rounded bg-surface-tint px-1 py-0.5 font-mono text-[0.9em] ${className || ''}`}>
        {children}
      </code>
    );
  },
  pre({ children }) {
    return (
      <pre className="mb-3 overflow-x-auto rounded-lg bg-fg1 p-3 text-sm leading-relaxed text-paper last:mb-0 [&_code]:bg-transparent [&_code]:p-0">
        {children}
      </pre>
    );
  },
  h1({ children }) {
    return <h1 className="mb-2 text-xl font-bold text-fg1">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mb-2 text-lg font-bold text-fg1">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mb-2 text-base font-bold text-fg1">{children}</h3>;
  },
  blockquote({ children }) {
    return <blockquote className="mb-3 border-l-4 border-primary-200 pl-3 text-fg2 last:mb-0">{children}</blockquote>;
  },
  table({ children }) {
    return (
      <div className="mb-3 overflow-x-auto last:mb-0">
        <table className="w-full border-collapse text-left text-sm">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className="border border-line bg-surface-tint px-2 py-1 font-bold text-fg1">{children}</th>;
  },
  td({ children }) {
    return <td className="border border-line px-2 py-1 align-top">{children}</td>;
  },
};

function MessageContent({ message }: { message: Message }) {
  if (message.role === 'user') {
    return (
      <div className="space-y-2">
        {message.content && <div className="whitespace-pre-wrap">{message.content}</div>}
        {!!message.attachments?.length && (
          <div className="grid gap-2">
            {message.attachments.map((attachment, index) => (
              <AttachmentPill key={`${attachment.name}-${index}`} attachment={attachment} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {message.content}
    </ReactMarkdown>
  );
}

function AttachmentPill({ attachment, onRemove }: { attachment: MessageAttachment; onRemove?: () => void }) {
  const image = isImageAttachment(attachment);
  const interactive = Boolean(onRemove);

  return (
    <div className={`flex max-w-full items-center gap-2 rounded-lg border px-2 py-2 text-sm ${
      interactive
        ? 'border-line bg-surface text-fg1'
        : 'border-white/20 bg-black/10'
    }`}>
      {image ? (
        <Image
          src={attachment.dataUrl || ''}
          alt=""
          width={40}
          height={40}
          unoptimized
          className="h-10 w-10 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${interactive ? 'bg-surface-tint text-fg2' : 'bg-white/15'}`}>
          <FileText className="h-4 w-4" strokeWidth={1.85} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{attachment.name}</p>
        <p className="text-xs opacity-75">{formatBytes(attachment.size)}</p>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove attachment"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-surface-tint"
        >
          <X className="h-4 w-4" strokeWidth={1.85} />
        </button>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <div key={i} className="w-2 h-2 bg-fg3 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </div>
  );
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [speechError, setSpeechError] = useState('');
  const [listening, setListening] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [publikTopUpUrl, setPublikTopUpUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const dictationBaseRef = useRef('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const resizeChatInput = useCallback(() => {
    const textarea = chatInputRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';

    const styles = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 24;
    const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
    const maxHeight = lineHeight * MAX_CHAT_INPUT_ROWS + paddingTop + paddingBottom;
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);

    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadHistory() {
      try {
        const res = await fetch('/api/worker/chat/history', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.messages)) {
          setMessages(data.messages.map((message: {
            id?: string;
            role: 'user' | 'assistant';
            content: string;
            createdAt?: string;
            creditsCharged?: number | null;
            model?: string | null;
          }) => ({
            id: message.id || crypto.randomUUID(),
            role: message.role,
            content: message.content,
            ts: message.createdAt ? Date.parse(message.createdAt) : Date.now(),
            creditsCharged: message.creditsCharged ?? null,
            model: message.model ?? null,
          })));
        }
      } catch (err: unknown) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.error('Failed to load chat history:', err);
        }
      } finally {
        if (!controller.signal.aborted) setHistoryLoading(false);
      }
    }

    loadHistory();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    resizeChatInput();
  }, [input, resizeChatInput]);

  useEffect(() => {
    window.addEventListener('resize', resizeChatInput);
    return () => window.removeEventListener('resize', resizeChatInput);
  }, [resizeChatInput]);

  useEffect(() => () => {
    const recognition = speechRecognitionRef.current;
    if (!recognition) return;
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.abort();
    speechRecognitionRef.current = null;
  }, []);

  async function toggleDictation() {
    const activeRecognition = speechRecognitionRef.current;
    if (activeRecognition) {
      activeRecognition.stop();
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSpeechError('Speech-to-text is not supported by this browser. Try a recent Chrome, Edge, or Safari browser.');
      return;
    }

    if (!window.isSecureContext) {
      setSpeechError('Voice dictation requires a secure HTTPS connection.');
      return;
    }

    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        permissionStream.getTracks().forEach((track) => track.stop());
      } catch (error) {
        setSpeechError(microphoneStartErrorMessage(error));
        return;
      }
    }

    setSpeechError('');
    const recognition = new SpeechRecognition();
    dictationBaseRef.current = input;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = navigator.language || 'en-US';
    recognition.onstart = () => {
      setListening(true);
      setSpeechError('');
    };
    recognition.onresult = (event) => {
      let transcript = '';
      for (let index = 0; index < event.results.length; index += 1) {
        const phrase = event.results[index]?.[0]?.transcript.trim() || '';
        if (phrase) transcript += `${transcript ? ' ' : ''}${phrase}`;
      }
      const base = dictationBaseRef.current;
      const separator = base && transcript && !/\s$/.test(base) ? ' ' : '';
      setInput(`${base}${separator}${transcript}`);
    };
    recognition.onerror = (event) => {
      setSpeechError(speechRecognitionErrorMessage(event.error));
      setListening(false);
    };
    recognition.onend = () => {
      if (speechRecognitionRef.current === recognition) {
        speechRecognitionRef.current = null;
      }
      setListening(false);
      requestAnimationFrame(() => chatInputRef.current?.focus());
    };

    speechRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      speechRecognitionRef.current = null;
      setListening(false);
      setSpeechError('The microphone could not start. Please try again.');
    }
  }

  async function addFiles(fileList: FileList | File[] | null) {
    if (!fileList?.length) return;

    setAttachmentError('');
    const availableSlots = MAX_ATTACHMENTS - attachments.length;
    if (availableSlots <= 0) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} files at a time.`);
      return;
    }

    const nextFiles = Array.from(fileList).slice(0, availableSlots);
    const nextAttachments: ChatAttachment[] = [];

    for (const file of nextFiles) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachmentError(`${file.name} is over ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
        continue;
      }

      try {
        nextAttachments.push({
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          dataUrl: await readFileAsDataUrl(file),
          file,
        });
      } catch {
        setAttachmentError(`Could not read ${file.name}.`);
      }
    }

    if (nextAttachments.length) {
      setAttachments((prev) => [...prev, ...nextAttachments]);
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pastedImages = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (!pastedImages.length) return;

    e.preventDefault();
    await addFiles(pastedImages);
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || loading || historyLoading || listening) return;

    const outgoingAttachments = attachments;
    const uploadedAttachments: UploadedAttachment[] = [];
    let assistantTs: number | null = null;
    let assistantMessageId: string | null = null;
    const updateAssistantMessage = (content: string) => {
      if (assistantTs === null) return;
      setMessages((prev) => prev.map((message) => (
        message.ts === assistantTs ? { ...message, content } : message
      )));
    };

    setAttachmentError('');
    setSpeechError('');
    setStatusMessage('');
    setPublikTopUpUrl(null);
    setLoading(true);

    try {
      for (const attachment of outgoingAttachments) {
        uploadedAttachments.push(await uploadAttachment(attachment));
      }

      const now = Date.now();
      assistantTs = now + 1;
      assistantMessageId = crypto.randomUUID();
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        ts: now,
        attachments: outgoingAttachments.map(({ name, mimeType, size, dataUrl }) => ({
          name,
          mimeType,
          size,
          dataUrl,
        })),
      };
      const assistantMsg: Message = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        ts: assistantTs,
        creditsCharged: null,
        model: null,
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput('');
      setAttachments([]);

      const res = await fetch('/api/worker/chat', {
        method: 'POST',
        headers: {
          'Accept': 'text/plain, application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: text,
          attachments: uploadedAttachments.map((attachment) => attachment.id),
          assistantMessageId,
        }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || contentType.includes('application/json') || !res.body) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 402) {
          const topUpUrl = publikLink(data.topUpUrl);
          if (topUpUrl) setPublikTopUpUrl(topUpUrl);
          if (typeof data.message === 'string') {
            updateAssistantMessage(data.message);
            return;
          }
        }
        updateAssistantMessage(data.reply || data.error || 'Sorry, something went wrong.');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let reply = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const delta = decoder.decode(value, { stream: true });
        if (!delta) continue;
        reply += delta;
        updateAssistantMessage(reply);
      }

      const tail = decoder.decode();
      if (tail) {
        reply += tail;
        updateAssistantMessage(reply);
      }

      if (!reply.trim()) {
        updateAssistantMessage('Sorry, something went wrong.');
      }

      const historyResponse = await fetch('/api/worker/chat/history?limit=50', {
        cache: 'no-store',
      }).catch(() => null);
      if (historyResponse?.ok && assistantMessageId) {
        const historyData = await historyResponse.json().catch(() => ({}));
        const saved = Array.isArray(historyData.messages)
          ? historyData.messages.find((message: { id?: string }) => message.id === assistantMessageId)
          : null;
        if (saved) {
          setMessages((prev) => prev.map((message) => (
            message.id === assistantMessageId
              ? {
                  ...message,
                  creditsCharged:
                    typeof saved.creditsCharged === 'number' ? saved.creditsCharged : null,
                  model: typeof saved.model === 'string' ? saved.model : null,
                }
              : message
          )));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection error. Please try again.';
      if (assistantTs === null) {
        await Promise.allSettled(uploadedAttachments.map((attachment) =>
          fetch(`/api/worker/attachments/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' })
        ));
        setAttachmentError(message);
      } else {
        updateAssistantMessage(message);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="sf-chat-page">
      <div className="sf-chat-scroll mb-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 sm:pr-2">
        {statusMessage && (
          <p className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-fg3" aria-live="polite">{statusMessage}</p>
        )}

        {publikTopUpUrl && (
          <p className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-fg3" role="status">
            <a href={publikTopUpUrl} target="_blank" rel="noreferrer" className="font-semibold text-primary-600 underline">
              Manage your Publik plan
            </a>
          </p>
        )}

        {historyLoading && (
          <div className="flex h-full items-center justify-center text-base text-fg3">
            Loading chat history...
          </div>
        )}

        {!historyLoading && messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-center">
            <p className="max-w-sm text-base text-fg3">
              No messages yet.
            </p>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={m.id} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'assistant' && (
              <StuAvatar />
            )}
            <div className="group relative max-w-lg">
              <div
                className={`sf-chat-text overflow-x-auto px-4 py-3 rounded-2xl text-base leading-relaxed ${m.role === 'user' ? 'bg-primary-500 text-white rounded-br-sm' : 'bg-surface border border-line text-fg1 rounded-bl-sm'}`}
                tabIndex={m.role === 'assistant' && m.creditsCharged != null ? 0 : undefined}
                aria-label={m.role === 'assistant' && m.creditsCharged != null
                  ? `${formatMessageCredits(m.creditsCharged)} credits used${m.model ? ` with ${m.model}` : ''}`
                  : undefined}
              >
                {m.role === 'assistant' && !m.content && loading && i === messages.length - 1 ? (
                  <TypingDots />
                ) : (
                  <MessageContent message={m} />
                )}
              </div>
              {m.role === 'assistant' && m.creditsCharged != null && (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute left-2 top-full z-20 mt-1 whitespace-nowrap rounded-md bg-fg1 px-2 py-1 text-xs font-medium text-paper opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  {formatMessageCredits(m.creditsCharged)} credits{m.model ? ` · ${m.model.replace('gpt-5.6-', '')}` : ''}
                </div>
              )}
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      <div className="space-y-2">
        {!!attachments.length && (
          <div className="grid gap-2 sm:grid-cols-2">
            {attachments.map((attachment, index) => (
              <AttachmentPill
                key={`${attachment.name}-${index}`}
                attachment={attachment}
                onRemove={() => removeAttachment(index)}
              />
            ))}
          </div>
        )}

        {attachmentError && (
          <p className="text-sm text-red-600">{attachmentError}</p>
        )}

        <div className="flex items-end gap-2 sm:gap-3">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={historyLoading || loading || listening || attachments.length >= MAX_ATTACHMENTS}
            title="Attach file"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-fg2 transition-colors hover:bg-surface-tint disabled:opacity-50"
          >
            <Paperclip className="h-4 w-4" strokeWidth={1.85} />
          </button>
          <textarea
            ref={chatInputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (speechError) setSpeechError('');
            }}
            onPaste={handlePaste}
            readOnly={listening}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask about your assignments, exams, grades..."
            rows={1}
            className="sf-chat-text min-h-11 min-w-0 flex-1 resize-none overflow-y-hidden rounded-xl border border-line bg-surface px-3 py-3 text-base leading-6 text-fg1 placeholder:text-fg3 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 sm:px-4"
          />
          <button
            type="button"
            onClick={() => void toggleDictation()}
            disabled={historyLoading || loading}
            aria-label={listening ? 'Stop voice dictation' : 'Start voice dictation'}
            aria-pressed={listening}
            title={listening ? 'Stop dictation' : 'Dictate message'}
            className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition-colors disabled:opacity-50 ${
              listening
                ? 'border-primary-500 bg-primary-500 text-white hover:bg-primary-600'
                : 'border-line bg-surface text-fg2 hover:bg-surface-tint'
            }`}
          >
            {listening ? (
              <>
                <span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-xl ring-2 ring-primary-500/40 animate-pulse"
                />
                <Square className="relative h-3.5 w-3.5 fill-current" strokeWidth={2} />
              </>
            ) : (
              <Mic className="h-4 w-4" strokeWidth={1.85} />
            )}
          </button>
          <button
            onClick={send}
            disabled={historyLoading || loading || listening || (!input.trim() && attachments.length === 0)}
            aria-label="Send message"
            className="bg-primary-500 text-white w-11 h-11 rounded-xl flex items-center justify-center hover:bg-primary-600 transition-colors disabled:opacity-50"
          >
            <Send className="w-4 h-4" strokeWidth={1.85} />
          </button>
        </div>
        {speechError && (
          <p className="text-sm text-red-600" role="alert">{speechError}</p>
        )}
      </div>
    </div>
  );
}
