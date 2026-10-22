# Mailtrack Chrome extension

Stops your own Gmail views of tracked emails from counting as opens.

When Gmail shows one of your tracked emails, the extension blanks the tracking pixel before it loads and tells `track.shotline.in` that you are looking at that email. Any open that still slips through in the next two minutes is marked "You".

Install: Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick this `extension/` folder. Install it in every Chrome profile where you read this Gmail account.

It only works in desktop Chrome. Opening your Sent mail in the Gmail phone app still counts; use "That was me" for those.
