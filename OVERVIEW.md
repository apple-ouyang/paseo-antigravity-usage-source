Antigravity usage source adds Antigravity CLI (`agy`) plan quota metrics to the Paseo usage panel.

It reads weekly and five-hour remaining quota percentages for Gemini and Claude/GPT tiers by invoking `agy -p "/quota"` on the daemon host and displays them alongside other provider usage panels.

Requires Antigravity CLI (`agy`) installed and logged in on the daemon host. No external network calls are made by the plugin itself beyond what `agy` queries for quota status.
