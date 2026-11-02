# pi-previous-message

Shows your previous message above the input box after a period of inactivity, so
you remember what you asked when you come back to a session.

```
 ───────────────────────
  previous message · 23 min ago
  hello world…
```

Typing does not dismiss it; sending a message with Enter does.

## Install

```bash
pi install git:github.com/Crack-Hu/pi-previous-message   # from GitHub
pi --extension /path/to/pi-previous-message              # local checkout, one session
pi install /path/to/pi-previous-message                  # local checkout, permanent
```

Run `/reload` after installing into a running session.

## Usage

```bash
/previous-message                  # show it now
/previous-message hide             # hide it
/previous-message on | off         # enable / disable
/previous-message status           # print current settings
```

Settings are arguments of the same command:

```bash
/previous-message SetLines 4           # body lines, 1-8 (default 4)
/previous-message SetInterval 10m      # delay before it appears (default 10m)
/previous-message SetPlacement widget  # widget | overlay (default widget)
/previous-message SetAutoShow on       # show on session open (default on)
/previous-message SetBrightness -2 2   # caption/body brightness, -5..5 (default 0 2)
```

| Argument | Meaning |
|---|---|
| `SetLines <1-8>` | How many lines of the message to show. Longer text ends with `…`. |
| `SetInterval <time>` | How long without keystrokes or agent output before it appears. Accepts `30s`, `5m`, `2h`, or a bare number of minutes. The unit you use is also used in the "ago" caption. |
| `SetPlacement <widget\|overlay>` | `widget` sits above the editor as a normal layout row; `overlay` floats at the top edge of the terminal. |
| `SetAutoShow <on\|off>` | Also show it immediately when opening a past session (`/resume`, `/fork`, `pi -c`). |
| `SetBrightness <caption> <body>` | Two numbers from `-5` to `5`. `0` is dim, `2` is muted, `5` is text; values in between blend between those theme colors. Negative values fade toward the background (`-5` is essentially invisible). First is the rule and caption, second is the message body. |

## Settings

Stored as `previous-message.json` in pi's agent directory (`~/.pi/agent` by default,
or wherever `PI_CODING_AGENT_DIR` points):

```json
{
  "enabled": true,
  "idleMinutes": 10,
  "intervalUnit": "m",
  "placement": "widget",
  "maxLines": 4,
  "autoShow": true,
  "captionLevel": 0,
  "bodyLevel": 2
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `idleMinutes` | `10` | Delay before the reminder appears, in minutes. |
| `intervalUnit` | `"m"` | Unit used by `SetInterval`, also used for the caption (`30s ago`, `12 min ago`, `3h ago`). |
| `placement` | `"widget"` | `widget` or `overlay`. |
| `maxLines` | `4` | Body lines shown, 1-8. |
| `autoShow` | `true` | Show immediately when a past session is opened. |
| `captionLevel` | `0` | Brightness of the rule and caption, -5 to 5 (0 dim, 2 muted, 5 text). |
| `bodyLevel` | `2` | Brightness of the message body, -5 to 5. |
