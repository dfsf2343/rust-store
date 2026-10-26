using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Oxide.Core;
using Oxide.Core.Libraries;

namespace Oxide.Plugins
{
    [Info("Web Store", "SCRAPYARD", "1.0.0")]
    [Description("Delivers kits bought on the server website: syncs purchases, enforces cooldowns and gives items.")]
    public class WebStore : RustPlugin
    {
        #region Configuration

        private PluginConfig config;

        private class PluginConfig
        {
            [JsonProperty("Store URL (same as BASE_URL on the website, no trailing slash)")]
            public string ApiUrl = "https://store.example.com";

            [JsonProperty("Shared secret (same as PLUGIN_SECRET on the website, 32+ characters)")]
            public string Secret = "";

            [JsonProperty("Server ID (letters, digits, - or _)")]
            public string ServerId = "main";

            [JsonProperty("Chat command")]
            public string Command = "claim";

            [JsonProperty("Chat prefix")]
            public string Prefix = "<color=#f0a04b>[Store]</color>";

            [JsonProperty("Remind players about ready kits when they connect")]
            public bool RemindOnConnect = true;
        }

        protected override void LoadDefaultConfig()
        {
            config = new PluginConfig();
        }

        protected override void LoadConfig()
        {
            base.LoadConfig();
            try
            {
                config = Config.ReadObject<PluginConfig>();
                if (config == null) throw new Exception("empty config");
            }
            catch (Exception ex)
            {
                PrintError($"Configuration file is invalid ({ex.Message}); using defaults.");
                LoadDefaultConfig();
            }
            SaveConfig();
        }

        protected override void SaveConfig()
        {
            Config.WriteObject(config, true);
        }

        #endregion

        #region Protocol types

#pragma warning disable 0649 // Fields are assigned by the JSON deserializer.

        private class KitItem
        {
            public string shortname;
            public int amount;
        }

        private class KitDef
        {
            public string id;
            public string name;
            public long cooldownSeconds;
            public List<KitItem> items = new List<KitItem>();
        }

        private class EntitlementDto
        {
            public string steamId;
            public string kitId;
            public long? expiresAt;
            public long? lastClaimAt;
        }

        private class NotificationDto
        {
            public long id;
            public string steamId;
            public string message;
        }

        private class SyncPayload
        {
            public string nonce;
            public long now;
            public int syncIntervalSeconds;
            public string catalogVersion;
            public List<KitDef> kits;
            public List<EntitlementDto> entitlements;
            public List<NotificationDto> notifications;
            public string storeUrl;
        }

        private class Envelope
        {
            public string payload;
            public string signature;
        }

        private class ClaimReport
        {
            public string id;
            public string steamId;
            public string kitId;
            public long at;
        }

        private class Access
        {
            /// <summary>Unix seconds, or -1 for lifetime.</summary>
            public long ExpiresAt;
            public long LastClaimAt;
        }

        private class StoredData
        {
            public string CatalogVersion;
            public string StoreUrl;
            public List<KitDef> Kits = new List<KitDef>();
            public Dictionary<string, Dictionary<string, Access>> Access = new Dictionary<string, Dictionary<string, Access>>();
            public List<ClaimReport> PendingClaims = new List<ClaimReport>();
            public List<long> PendingDelivered = new List<long>();
            public long ClockOffset;
        }

#pragma warning restore 0649

        #endregion

        #region State

        private StoredData data;
        private Dictionary<string, KitDef> kitsById = new Dictionary<string, KitDef>(StringComparer.OrdinalIgnoreCase);
        private readonly List<NotificationDto> waitingForPlayer = new List<NotificationDto>();
        private readonly HashSet<long> shownNotifications = new HashSet<long>();
        private Timer syncTimer;
        private bool syncInFlight;
        private bool dataDirty;
        private int failures;
        private float intervalSeconds = 15f;
        private bool warnedSecret;

        #endregion

        #region Hooks

        private void Init()
        {
            LoadData();
        }

        private void OnServerInitialized(bool initial)
        {
            var command = (config.Command ?? string.Empty).Trim().TrimStart('/').ToLowerInvariant();
            if (command.Length == 0 || command.Length > 24 || command.Any(c => !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')))
            {
                PrintError($"Invalid chat command '{config.Command}' in config (use a-z, 0-9 or _); falling back to 'claim'.");
                command = "claim";
            }
            config.Command = command;
            cmd.AddChatCommand(config.Command, this, CmdClaim);
            cmd.AddConsoleCommand("webstore.sync", this, ConsoleSync);
            ScheduleSync(3f);
        }

        private void OnPlayerConnected(BasePlayer player)
        {
            if (player == null) return;
            timer.Once(8f, () =>
            {
                if (player == null || !player.IsConnected) return;
                DeliverWaiting(player);
                if (!config.RemindOnConnect) return;
                var ready = OwnedKits(player.UserIDString).Where(k => CooldownRemaining(player.UserIDString, k) <= 0).Select(k => k.name).ToList();
                if (ready.Count > 0)
                    Reply(player, $"Kits ready to claim: <color=#9fd36b>{string.Join(", ", ready)}</color>. Type /{config.Command} to see them.");
            });
        }

        private void OnServerSave()
        {
            SaveData(true);
        }

        private void Unload()
        {
            syncTimer?.Destroy();
            SaveData(true);
        }

        #endregion

        #region Sync

        private void ScheduleSync(float delaySeconds)
        {
            syncTimer?.Destroy();
            syncTimer = timer.Once(Math.Max(1f, delaySeconds), Sync);
        }

        private long Now()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeSeconds() + data.ClockOffset;
        }

        private void Sync()
        {
            if (syncInFlight) return;
            if (string.IsNullOrEmpty(config.Secret) || config.Secret.Length < 32 || config.ApiUrl.Contains("example.com"))
            {
                if (!warnedSecret) PrintWarning("Set the store URL and the shared secret in oxide/config/WebStore.json, then reload the plugin.");
                warnedSecret = true;
                ScheduleSync(60f);
                return;
            }

            var nonce = Guid.NewGuid().ToString("N");
            var claims = data.PendingClaims.Take(200).ToList();
            var delivered = data.PendingDelivered.Take(200).ToList();
            var body = JsonConvert.SerializeObject(new
            {
                nonce,
                serverId = config.ServerId,
                catalogVersion = data.CatalogVersion,
                status = BuildStatus(),
                claims,
                delivered
            });
            var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
            var headers = new Dictionary<string, string>
            {
                ["Content-Type"] = "application/json",
                ["X-Store-Server"] = config.ServerId,
                ["X-Store-Timestamp"] = timestamp,
                ["X-Store-Signature"] = Hmac(config.Secret, timestamp + "\n" + body)
            };

            syncInFlight = true;
            webrequest.Enqueue(config.ApiUrl.TrimEnd('/') + "/api/plugin/sync", body, (code, response) =>
            {
                syncInFlight = false;
                try
                {
                    HandleSync(code, response, nonce, claims, delivered);
                }
                catch (Exception ex)
                {
                    Fail($"could not process the store response: {ex.Message}");
                }
            }, this, RequestMethod.POST, headers, 20f);
        }

        private void HandleSync(int code, string response, string nonce, List<ClaimReport> sentClaims, List<long> sentDelivered)
        {
            if (code != 200 || string.IsNullOrEmpty(response))
            {
                Fail($"HTTP {code}: {Truncate(response, 200)}");
                return;
            }
            var envelope = JsonConvert.DeserializeObject<Envelope>(response);
            if (envelope == null || envelope.payload == null || !SafeEquals(Hmac(config.Secret, envelope.payload), envelope.signature))
            {
                Fail("response signature is invalid (check the shared secret and the store URL)");
                return;
            }
            var payload = JsonConvert.DeserializeObject<SyncPayload>(envelope.payload);
            if (payload == null || payload.nonce != nonce)
            {
                Fail("response does not match the request");
                return;
            }

            if (failures > 0) Puts("Store connection restored.");
            failures = 0;
            data.ClockOffset = payload.now - DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            data.StoreUrl = payload.storeUrl;

            var sentIds = new HashSet<string>(sentClaims.Select(c => c.id));
            data.PendingClaims.RemoveAll(c => sentIds.Contains(c.id));
            var deliveredIds = new HashSet<long>(sentDelivered);
            data.PendingDelivered.RemoveAll(id => deliveredIds.Contains(id));

            if (payload.kits != null)
            {
                data.Kits = payload.kits;
                data.CatalogVersion = payload.catalogVersion;
                IndexKits();
                ValidateKits();
                Puts($"Loaded {data.Kits.Count} kits from the store (catalog {payload.catalogVersion}).");
            }

            ApplyEntitlements(payload.entitlements ?? new List<EntitlementDto>());

            waitingForPlayer.Clear();
            foreach (var n in payload.notifications ?? new List<NotificationDto>())
            {
                if (shownNotifications.Contains(n.id))
                {
                    if (!data.PendingDelivered.Contains(n.id)) data.PendingDelivered.Add(n.id);
                    continue;
                }
                var player = FindOnline(n.steamId);
                if (player != null) ShowNotification(player, n);
                else waitingForPlayer.Add(n);
            }

            dataDirty = true;
            SaveData(false);
            intervalSeconds = Math.Max(5, Math.Min(300, payload.syncIntervalSeconds > 0 ? payload.syncIntervalSeconds : 15));
            ScheduleSync(intervalSeconds);
        }

        private void Fail(string reason)
        {
            failures++;
            if (failures == 1 || failures % 20 == 0) PrintWarning($"Store sync failed ({failures}x): {reason}");
            ScheduleSync(Math.Min(120f, intervalSeconds * Math.Min(failures, 8)));
        }

        private void ApplyEntitlements(List<EntitlementDto> entitlements)
        {
            var next = new Dictionary<string, Dictionary<string, Access>>();
            foreach (var e in entitlements)
            {
                if (string.IsNullOrEmpty(e.steamId) || string.IsNullOrEmpty(e.kitId)) continue;
                Dictionary<string, Access> kits;
                if (!next.TryGetValue(e.steamId, out kits))
                {
                    kits = new Dictionary<string, Access>(StringComparer.OrdinalIgnoreCase);
                    next[e.steamId] = kits;
                }
                long localLast = 0;
                Dictionary<string, Access> previousKits;
                Access previous;
                if (data.Access.TryGetValue(e.steamId, out previousKits) && previousKits.TryGetValue(e.kitId, out previous))
                    localLast = previous.LastClaimAt;
                kits[e.kitId] = new Access
                {
                    ExpiresAt = e.expiresAt.HasValue ? e.expiresAt.Value : -1,
                    LastClaimAt = Math.Max(localLast, e.lastClaimAt ?? 0)
                };
            }
            data.Access = next;
        }

        private object BuildStatus()
        {
            var queue = ServerMgr.Instance != null ? ServerMgr.Instance.connectionQueue : null;
            return new
            {
                hostname = ConVar.Server.hostname,
                players = BasePlayer.activePlayerList.Count,
                maxPlayers = ConVar.Server.maxplayers,
                queued = queue != null ? queue.Queued : 0,
                joining = queue != null ? queue.Joining : 0,
                sleepers = BasePlayer.sleepingPlayerList.Count,
                worldSize = (long)World.Size,
                seed = (long)World.Seed,
                fps = Performance.report.frameRate,
                command = config.Command,
                pluginVersion = Version.ToString()
            };
        }

        #endregion

        #region Claiming

        private void CmdClaim(BasePlayer player, string command, string[] args)
        {
            if (player == null) return;
            var steamId = player.UserIDString;
            var owned = OwnedKits(steamId);

            if (args == null || args.Length == 0)
            {
                if (owned.Count == 0)
                {
                    Reply(player, $"You have no store kits yet. Get one at <color=#9fd36b>{StoreUrl()}</color>");
                    return;
                }
                var sb = new StringBuilder("Your kits:");
                foreach (var kit in owned)
                {
                    var remaining = CooldownRemaining(steamId, kit);
                    var state = remaining <= 0 ? "<color=#9fd36b>READY</color>" : $"<color=#e0b45a>ready in {FormatDuration(remaining)}</color>";
                    sb.Append($"\n<color=#f0a04b>/{config.Command} {kit.id}</color>  {kit.name}: {state}, {ExpiryText(steamId, kit)}");
                }
                Reply(player, sb.ToString());
                return;
            }

            var wanted = args[0];
            KitDef target;
            if (!kitsById.TryGetValue(wanted, out target))
                target = data.Kits.FirstOrDefault(k => string.Equals(k.name, wanted, StringComparison.OrdinalIgnoreCase));
            if (target == null)
            {
                Reply(player, $"Unknown kit '{wanted}'. Type /{config.Command} to list your kits.");
                return;
            }
            if (!owned.Contains(target))
            {
                Reply(player, $"You don't own the {target.name} kit. Get it at <color=#9fd36b>{StoreUrl()}</color>");
                return;
            }
            if (player.IsDead() || player.IsWounded() || player.IsSleeping())
            {
                Reply(player, "You can't claim a kit right now.");
                return;
            }
            var wait = CooldownRemaining(steamId, target);
            if (wait > 0)
            {
                Reply(player, $"The {target.name} kit is on cooldown for {FormatDuration(wait)}.");
                return;
            }
            var needed = SlotsNeeded(target);
            var free = FreeSlots(player);
            if (free < needed)
            {
                Reply(player, $"The {target.name} kit needs {needed} free inventory slots. You have {free}.");
                return;
            }

            GiveKit(player, target);

            var now = Now();
            Access access;
            Dictionary<string, Access> kits;
            if (data.Access.TryGetValue(steamId, out kits) && kits.TryGetValue(target.id, out access)) access.LastClaimAt = now;
            data.PendingClaims.Add(new ClaimReport { id = Guid.NewGuid().ToString(), steamId = steamId, kitId = target.id, at = now });
            dataDirty = true;
            SaveData(true);

            var next = target.cooldownSeconds > 0 ? $" Next claim in {FormatDuration(target.cooldownSeconds)}." : string.Empty;
            Reply(player, $"You received the <color=#9fd36b>{target.name}</color> kit.{next}");
            Puts($"{player.displayName} ({steamId}) claimed the {target.id} kit.");
        }

        private List<KitDef> OwnedKits(string steamId)
        {
            var result = new List<KitDef>();
            Dictionary<string, Access> kits;
            if (!data.Access.TryGetValue(steamId, out kits)) return result;
            var now = Now();
            foreach (var pair in kits)
            {
                KitDef kit;
                if (!kitsById.TryGetValue(pair.Key, out kit)) continue;
                if (pair.Value.ExpiresAt == -1 || pair.Value.ExpiresAt > now) result.Add(kit);
            }
            return result.OrderBy(k => k.cooldownSeconds).ToList();
        }

        private long CooldownRemaining(string steamId, KitDef kit)
        {
            Dictionary<string, Access> kits;
            Access access;
            if (!data.Access.TryGetValue(steamId, out kits) || !kits.TryGetValue(kit.id, out access)) return 0;
            if (access.LastClaimAt <= 0) return 0;
            return Math.Max(0, access.LastClaimAt + kit.cooldownSeconds - Now());
        }

        private string ExpiryText(string steamId, KitDef kit)
        {
            Dictionary<string, Access> kits;
            Access access;
            if (!data.Access.TryGetValue(steamId, out kits) || !kits.TryGetValue(kit.id, out access)) return "expired";
            if (access.ExpiresAt == -1) return "lifetime";
            return $"expires in {FormatDuration(access.ExpiresAt - Now())}";
        }

        private int SlotsNeeded(KitDef kit)
        {
            var slots = 0;
            foreach (var item in kit.items)
            {
                var def = ItemManager.FindItemDefinition(item.shortname);
                if (def == null || item.amount <= 0) continue;
                var stack = Math.Max(1, def.stackable);
                slots += (item.amount + stack - 1) / stack;
            }
            return slots;
        }

        private static int FreeSlots(BasePlayer player)
        {
            return Free(player.inventory.containerMain) + Free(player.inventory.containerBelt);
        }

        private static int Free(ItemContainer container)
        {
            return container == null ? 0 : Math.Max(0, container.capacity - container.itemList.Count);
        }

        private void GiveKit(BasePlayer player, KitDef kit)
        {
            foreach (var entry in kit.items)
            {
                var def = ItemManager.FindItemDefinition(entry.shortname);
                if (def == null) continue;
                var stack = Math.Max(1, def.stackable);
                var remaining = entry.amount;
                while (remaining > 0)
                {
                    var amount = Math.Min(stack, remaining);
                    // Skin 0: kits never hand out paid or DLC skins.
                    var item = ItemManager.CreateByName(entry.shortname, amount, 0UL);
                    if (item == null) break;
                    player.GiveItem(item, BaseEntity.GiveItemReason.PickedUp);
                    remaining -= amount;
                }
            }
        }

        private void ValidateKits()
        {
            foreach (var kit in data.Kits)
                foreach (var item in kit.items)
                    if (ItemManager.FindItemDefinition(item.shortname) == null)
                        PrintWarning($"Kit '{kit.id}' contains an unknown item shortname '{item.shortname}'. It will be skipped.");
        }

        #endregion

        #region Notifications

        private void ShowNotification(BasePlayer player, NotificationDto n)
        {
            Reply(player, n.message);
            shownNotifications.Add(n.id);
            if (!data.PendingDelivered.Contains(n.id)) data.PendingDelivered.Add(n.id);
        }

        private void DeliverWaiting(BasePlayer player)
        {
            var mine = waitingForPlayer.Where(n => n.steamId == player.UserIDString).ToList();
            foreach (var n in mine)
            {
                ShowNotification(player, n);
                waitingForPlayer.Remove(n);
            }
            if (mine.Count > 0)
            {
                dataDirty = true;
                SaveData(false);
            }
        }

        #endregion

        #region Console

        private bool ConsoleSync(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null && !arg.IsAdmin) return false;
            ScheduleSync(0.5f);
            var players = data.Access.Count;
            arg.ReplyWith($"[Web Store] Sync queued. Kits: {data.Kits.Count}, players with kits: {players}, pending claim reports: {data.PendingClaims.Count}, failures: {failures}.");
            return true;
        }

        #endregion

        #region Helpers

        private void IndexKits()
        {
            kitsById = new Dictionary<string, KitDef>(StringComparer.OrdinalIgnoreCase);
            foreach (var kit in data.Kits)
                if (!string.IsNullOrEmpty(kit.id)) kitsById[kit.id] = kit;
        }

        private void LoadData()
        {
            try
            {
                data = Interface.Oxide.DataFileSystem.ReadObject<StoredData>(Name);
            }
            catch (Exception ex)
            {
                PrintError($"Could not read the data file ({ex.Message}); starting empty.");
                data = null;
            }
            if (data == null) data = new StoredData();
            if (data.Kits == null) data.Kits = new List<KitDef>();
            if (data.Access == null) data.Access = new Dictionary<string, Dictionary<string, Access>>();
            if (data.PendingClaims == null) data.PendingClaims = new List<ClaimReport>();
            if (data.PendingDelivered == null) data.PendingDelivered = new List<long>();
            // Keep the claim report queue bounded if the store is unreachable for a long time.
            if (data.PendingClaims.Count > 5000) data.PendingClaims = data.PendingClaims.Skip(data.PendingClaims.Count - 5000).ToList();
            IndexKits();
        }

        private void SaveData(bool force)
        {
            if (data == null || (!force && !dataDirty)) return;
            Interface.Oxide.DataFileSystem.WriteObject(Name, data);
            dataDirty = false;
        }

        private string StoreUrl()
        {
            return string.IsNullOrEmpty(data.StoreUrl) ? config.ApiUrl : data.StoreUrl;
        }

        private static BasePlayer FindOnline(string steamId)
        {
            foreach (var p in BasePlayer.activePlayerList)
                if (p != null && p.UserIDString == steamId) return p;
            return null;
        }

        private void Reply(BasePlayer player, string message)
        {
            player.ChatMessage($"{config.Prefix} {message}");
        }

        private static string FormatDuration(long seconds)
        {
            if (seconds < 0) seconds = 0;
            var span = TimeSpan.FromSeconds(seconds);
            if (span.TotalDays >= 1) return $"{(int)span.TotalDays}d {span.Hours}h";
            if (span.TotalHours >= 1) return $"{(int)span.TotalHours}h {span.Minutes}m";
            if (span.TotalMinutes >= 1) return $"{span.Minutes}m {span.Seconds}s";
            return $"{span.Seconds}s";
        }

        private static string Truncate(string value, int max)
        {
            if (string.IsNullOrEmpty(value)) return "(no response)";
            return value.Length <= max ? value : value.Substring(0, max) + "...";
        }

        private static string Hmac(string secret, string message)
        {
            using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret)))
            {
                var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(message));
                var sb = new StringBuilder(hash.Length * 2);
                foreach (var b in hash) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        private static bool SafeEquals(string a, string b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            var diff = 0;
            for (var i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }

        #endregion
    }
}
