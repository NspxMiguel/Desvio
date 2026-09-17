# Desvio

A desktop assistant for macOS and Linux that answers WhatsApp for you, in your own
voice — and tells you when a message was written by a machine.

Everything runs on your computer. The WhatsApp session, your writing samples and
your settings never leave it; only the text of the conversations you configured is
sent to Groq to draft a reply.

## How it works

You link your account with the usual WhatsApp QR code, pick which people the
assistant is allowed to answer, and choose per person whether it asks you first or
replies on its own.

**Nobody is answered by default.** The list is an allow-list: a contact that is not
on it never receives anything, and group chats are ignored entirely. Watching for
important messages is separate and covers every one-to-one conversation, including
the people who never get a reply.

## Writing in your voice

Desvio learns from the messages you have actually sent. You choose how far back to
read — a week, a month, three months, a year, or everything WhatsApp Web can load —
and those messages become the examples the model imitates: your cadence, your
abbreviations, your slang.

Two things keep that learning honest:

- **Everything Desvio writes ends with two invisible characters** (`U+3164`,
  Hangul Filler). They are blank on screen but they are ordinary letters to
  Unicode, so nothing trims them away. A message carrying that marker is never
  learned from — the assistant cannot end up imitating itself.
- **Text written by some other assistant is turned away too.** Messages you drafted
  elsewhere and pasted into WhatsApp carry no marker, so every candidate sample is
  scored first, and anything that reads as machine-written is refused.

## The AI reading

Under every box where you compose, Desvio scores what is currently written and
lists why. The signals it looks for:

| Signal                                  | Why it matters                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| Invisible characters                    | Assistants and copy buttons leave them behind; phone keyboards do not          |
| Desvio's own marker                     | Certainty, not suspicion — Desvio put it there                                 |
| Em dashes                               | Nobody types them on a phone                                                   |
| Curly quotes, single-character ellipsis | Come from editors, not keyboards                                               |
| Bulleted lists                          | Not how chat works                                                             |
| Support-desk phrasing                   | Nobody texts a friend "I remain at your disposal"                              |
| Punctuation too clean for the length    | Only counts alongside another signal, so writing properly is not an accusation |

The same score runs on incoming messages, so a friend answering you with a chatbot
shows up as a badge with its reasons. It is suspicion with evidence attached, never
a verdict: only the marker is treated as certain.

## Important messages

Every direct conversation is watched. A message judged urgent — a deadline, money,
an emergency, a question only you can answer — raises a desktop notification and can
POST a small JSON event to a webhook. Point that at Home Assistant and it announces
on Alexa, Google Nest, or anything else you have.

## Media

Photos, videos, voice notes and stickers are fetched only when you ask to see them,
cached on disk rather than held in memory, and shown inside the message. Links —
Instagram, TikTok, YouTube — open in a separate window of the app with its own
isolated session.

## Running it

```sh
bun install
bun start
```

A Groq key goes in Settings, or in `.env` as `GROQ_API_KEY`; the free tier is
enough. The model list comes from your key: if Groq retires the one you are using,
Desvio picks a working one instead of failing on every message.

`DESVIO_LANG=pt` or `DESVIO_LANG=en` forces the interface language for one run. The
interface otherwise follows the system, and the choice can be changed in Settings.

Tests cover the parts that fail silently — phone-number matching across the forms
WhatsApp uses, the invisible marker, and the scoring:

```sh
bun test
```

Electron needs Node tooling for its binary, so `bun install` is what sets the
project up; `bun test` runs the suite directly.

## Requirements

- macOS or Linux
- Chrome or Chromium installed — the WhatsApp session runs in it headlessly
  (`DESVIO_CHROME_PATH` points at a specific binary if needed)
- A free Groq API key

## Honest limits

This drives WhatsApp Web through an unofficial library. It is built for one person
running it on their own account. WhatsApp can change its protocol at any time, and
automating an account carries whatever risk their terms imply — that is your call to
make, not the app's.

The AI reading is a heuristic. It can miss a machine-written message that leaves no
trace, and a very formal human can score low. Treat it as a hint with reasons, which
is why the reasons are always shown.

## Licence

MIT.
