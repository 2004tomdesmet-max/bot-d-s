require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ]
});

const CHANNEL_ID = process.env.CHANNEL_ID;
const ANNONCES_CHANNEL_ID = "1567147974822469813";
const PREUVES_CHANNEL_ID = "1567149477914087535";
const JOURNAL_CHANNEL_ID = "1567149506745602100";
const RETOURS_CHANNEL_ID = "1567149194244788376";
const DEMANDES_CHANNEL_ID = "1567148763175198760";
const RETOURS_DEMANDES_CHANNEL_ID = "1567148784889233458";
const TABLEAU_CHANNEL_ID = "1567187177283129384";
const PUNITIONS_CHANNEL_ID = "1567186290170929342";
const SESSIONS_CHANNEL_ID = "1567186618090135652";
const ORDRES_CHANNEL_ID = "1567149145838325821";
const AVERTISSEMENTS_CHANNEL_ID = "1567149532737839166";
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const OWNER_ID = "1236056295338147991";

const checkinHours = ['8', '12', '16', '20'];
const pendingProofs = new Map();

let warnings = [];
let dashboardMessageId = null;
let morningTasks = [];
let eveningTasks = [];

function loadWarnings() {
  try {
    if (fs.existsSync('warnings.json')) {
      warnings = JSON.parse(fs.readFileSync('warnings.json', 'utf8'));
    }
  } catch (e) {
    warnings = [];
  }
}

function saveWarnings() {
  fs.writeFileSync('warnings.json', JSON.stringify(warnings));
}

function loadDashboardId() {
  try {
    if (fs.existsSync('dashboard.json')) {
      const data = JSON.parse(fs.readFileSync('dashboard.json', 'utf8'));
      dashboardMessageId = data.messageId;
    }
  } catch (e) {}
}

function saveDashboardId() {
  fs.writeFileSync('dashboard.json', JSON.stringify({ messageId: dashboardMessageId }));
}

client.once('clientReady', async () => {
  console.log(`Bot connecté en tant que ${client.user.tag}`);
  loadWarnings();
  loadDashboardId();
  await updateDashboard();

  checkinHours.forEach(hour => {
    cron.schedule(`0 ${hour} * * *`, () => {
      sendCheckin(hour);
    }, { timezone: "Europe/Paris" });
  });

  scheduleRandomProofs();

  cron.schedule('30 20 * * *', () => sendJournalReminder(), { timezone: "Europe/Paris" });
  cron.schedule('0 22 * * *', () => checkJournal(), { timezone: "Europe/Paris" });
  cron.schedule('30 21 * * *', () => sendRetoursReminder(), { timezone: "Europe/Paris" });
  cron.schedule('0 23 * * *', () => checkRetours(), { timezone: "Europe/Paris" });

  cron.schedule('0 7 * * *', () => postDailyTasks(), { timezone: "Europe/Paris" });
  cron.schedule('0 12 * * *', () => checkMorningTasks(), { timezone: "Europe/Paris" });
  cron.schedule('0 23 * * *', () => checkEveningTasks(), { timezone: "Europe/Paris" });
});

function getRecentWarnings() {
  const now = Date.now();
  warnings = warnings.filter(ts => now - ts < 24 * 60 * 60 * 1000);
  saveWarnings();
  return warnings.length;
}

async function updateDashboard() {
  const count = getRecentWarnings();
  let status = "Normal";
  if (count >= 8) status = "Punition";
  else if (count >= 6) status = "Contrôle renforcé";
  else if (count >= 4) status = "Avertissement";
  else if (count >= 2) status = "Attention";

  const content = `**Tableau de bord**\n\n⚠️ Avertissements (24h) : **${count}**\n📌 État : **${status}**`;

  const channel = await client.channels.fetch(TABLEAU_CHANNEL_ID);
  
  if (dashboardMessageId) {
    try {
      const msg = await channel.messages.fetch(dashboardMessageId);
      await msg.edit(content);
      return;
    } catch (e) {
      dashboardMessageId = null;
    }
  }

  const msg = await channel.send(content);
  dashboardMessageId = msg.id;
  saveDashboardId();
}

async function addWarning(guild, reason) {
  warnings.push(Date.now());
  saveWarnings();
  const count = getRecentWarnings();
  await updateDashboard();

  const channel = await client.channels.fetch(ANNONCES_CHANNEL_ID);

  await channel.send(`⚠️ **Avertissement** – ${reason}\nTotal (24h) : **${count}**`);

  if (count === 2) {
    await channel.send(`⚠️ **Attention** – Tu as maintenant **2 avertissements** sur les dernières 24h.`);
  }
  if (count === 4) {
    await channel.send(`⚠️ **Avertissement** – Tu as **4 avertissements**. Fais attention.`);
    try {
      const owner = await client.users.fetch(OWNER_ID);
      await owner.send(`Elle a atteint **4 avertissements** en 24h. Dernier motif : ${reason}`);
    } catch (e) {}
  }
  if (count === 6) {
    const role = guild.roles.cache.find(r => r.name === "Contrôle renforcé");
    if (role) {
      const soumise = guild.members.cache.find(m => m.roles.cache.some(r => r.name === "Soumise"));
      if (soumise) await soumise.roles.add(role);
    }
    await channel.send(`🔒 **Contrôle renforcé activé** (6 avertissements).`);
  }
  if (count === 8) {
    const role = guild.roles.cache.find(r => r.name === "punition");
    if (role) {
      const soumise = guild.members.cache.find(m => m.roles.cache.some(r => r.name === "Soumise"));
      if (soumise) await soumise.roles.add(role);
    }
    await channel.send(`⛓️ **Punition activée** (8 avertissements).`);

    const punitionsChannel = await client.channels.fetch(PUNITIONS_CHANNEL_ID);
    await punitionsChannel.send(`⛓️ **Punition activée**\nDate : ${new Date().toLocaleString("fr-FR")}\nAvertissements : 8`);
  }

  const avertissementsChannel = await client.channels.fetch(AVERTISSEMENTS_CHANNEL_ID);
  await avertissementsChannel.send(`⚠️ **Avertissement**\nMotif : ${reason}\nDate : ${new Date().toLocaleString("fr-FR")}`);

  await axios.post(APPS_SCRIPT_URL, {
    type: "avertissement",
    motif: reason,
    type_avertissement: "Général"
  });
}

async function setSpeechPermission(guild, canSpeak) {
  const soumiseRole = guild.roles.cache.find(r => r.name === "Soumise");
  if (!soumiseRole) return;

  const channelIds = [CHANNEL_ID, SESSIONS_CHANNEL_ID, PUNITIONS_CHANNEL_ID];

  for (const id of channelIds) {
    const channel = await client.channels.fetch(id);
    await channel.permissionOverwrites.edit(soumiseRole, {
      SendMessages: canSpeak
    });
  }
}

function getMorningTasks() {
  return [
    "Réveil",
    "Lavage",
    "Skincare matin",
    "Habillage",
    "Coiffage",
    "Maquillage"
  ];
}

function getEveningTasks() {
  const day = new Date().getDay();
  const date = new Date().getDate();
  const month = new Date().getMonth();

  let tasks = [
    "Démaquillage",
    "Skincare soir",
    "Lavage (soir)",
    "Coucher à 23h"
  ];

  if (day === 3) tasks.push("Lavage de cheveux", "Limage des ongles");
  if (day === 6) tasks.push("Ménage");
  if (day === 0) tasks.push("Rasage", "Sourcils", "Couper les ongles", "Changer les draps", "Changer les serviettes", "Shampoing");

  if (date === 15) {
    tasks.push("Prendre RDV ongles");
    if ([0, 3, 6, 9].includes(month)) tasks.push("RDV coiffeur");
  }

  return tasks;
}

async function postDailyTasks() {
  const channel = await client.channels.fetch(ORDRES_CHANNEL_ID);
  morningTasks = [];
  eveningTasks = [];

  await channel.send("**Tâches du matin**\nÀ valider avant 12h.");
  for (const task of getMorningTasks()) {
    const msg = await channel.send(`- ${task}`);
    await msg.react('✅');
    morningTasks.push({ id: msg.id, task });
  }

  await channel.send("**Tâches du soir**\nÀ valider avant 23h.");
  for (const task of getEveningTasks()) {
    const msg = await channel.send(`- ${task}`);
    await msg.react('✅');
    eveningTasks.push({ id: msg.id, task });
  }
}

async function checkMorningTasks() {
  await checkTaskList(morningTasks, "matin");
}

async function checkEveningTasks() {
  await checkTaskList(eveningTasks, "soir");
}

async function checkTaskList(taskList, period) {
  const channel = await client.channels.fetch(ORDRES_CHANNEL_ID);
  let missing = [];

  for (const t of taskList) {
    try {
      const msg = await channel.messages.fetch(t.id);
      const reaction = msg.reactions.cache.get('✅');
      const done = reaction && reaction.count > 1;
      
      await axios.post(APPS_SCRIPT_URL, {
        type: "tache",
        tache: t.task,
        statut: done ? "Faite" : "Non faite"
      });

      if (!done) missing.push(t.task);
    } catch (e) {}
  }

  if (missing.length > 0) {
    const annonces = await client.channels.fetch(ANNONCES_CHANNEL_ID);
    await annonces.send(`❌ **Tâches du ${period} non faites :**\n${missing.map(m => `- ${m}`).join('\n')}`);
    await addWarning(annonces.guild, `Tâches ${period} non faites : ${missing.join(', ')}`);
  }
}

async function sendJournalReminder() {
  const channel = await client.channels.fetch(ANNONCES_CHANNEL_ID);
  await channel.send(`📝 **Rappel** – N’oublie pas d’écrire dans <#${JOURNAL_CHANNEL_ID}> avant 22h.`);
}

async function checkJournal() {
  const journalChannel = await client.channels.fetch(JOURNAL_CHANNEL_ID);
  const messages = await journalChannel.messages.fetch({ limit: 50 });
  const today = new Date().toDateString();

  const hasPosted = messages.some(m => 
    !m.author.bot && new Date(m.createdTimestamp).toDateString() === today
  );

  if (!hasPosted) {
    const annonces = await client.channels.fetch(ANNONCES_CHANNEL_ID);
    await annonces.send(`❌ **Journal manquant** – Tu n’as pas écrit dans <#${JOURNAL_CHANNEL_ID}> aujourd’hui.`);
    await addWarning(annonces.guild, "Journal non écrit");
  }
}

async function sendRetoursReminder() {
  const channel = await client.channels.fetch(ANNONCES_CHANNEL_ID);
  await channel.send(`📝 **Rappel** – N’oublie pas d’écrire dans <#${RETOURS_CHANNEL_ID}> avant 23h.`);
}

async function checkRetours() {
  const retoursChannel = await client.channels.fetch(RETOURS_CHANNEL_ID);
  const messages = await retoursChannel.messages.fetch({ limit: 50 });
  const today = new Date().toDateString();

  const hasPosted = messages.some(m => 
    !m.author.bot && new Date(m.createdTimestamp).toDateString() === today
  );

  if (!hasPosted) {
    const annonces = await client.channels.fetch(ANNONCES_CHANNEL_ID);
    await annonces.send(`❌ **Retours manquants** – Tu n’as pas écrit dans <#${RETOURS_CHANNEL_ID}> aujourd’hui.`);
    await addWarning(annonces.guild, "Retours-ordres non écrits");
  }
}

function scheduleRandomProofs() {
  const times = [];
  for (let i = 0; i < 4; i++) {
    const hour = Math.floor(Math.random() * (22 - 8 + 1)) + 8;
    const minute = Math.floor(Math.random() * 60);
    times.push({ hour, minute });
  }
  times.sort((a, b) => a.hour - b.hour || a.minute - b.minute);

  times.forEach(time => {
    cron.schedule(`${time.minute} ${time.hour} * * *`, () => {
      sendProofRequest();
    }, { timezone: "Europe/Paris" });
  });

  console.log(`Preuves aléatoires planifiées à : ${times.map(t => `${t.hour}h${t.minute.toString().padStart(2, '0')}`).join(', ')}`);
}

async function sendProofRequest() {
  const channel = await client.channels.fetch(ANNONCES_CHANNEL_ID);
  if (!channel) return;

  const message = await channel.send({
    content: `**Preuve demandée**\nTu as 30 minutes pour poster une preuve dans <#${PREUVES_CHANNEL_ID}>.\n\n**Format :** Preuve - [nom de la tâche ou de l'ordre] • Fichier(s) joint(s)`
  });

  const reminder = setTimeout(async () => {
    if (pendingProofs.has(message.id)) {
      await channel.send(`⏰ **Rappel** – Il te reste 10 minutes pour poster ta preuve dans <#${PREUVES_CHANNEL_ID}>.`);
    }
  }, 20 * 60 * 1000);

  const timeout = setTimeout(async () => {
    if (pendingProofs.has(message.id)) {
      await channel.send(`❌ **Preuve manquée**`);
      await addWarning(channel.guild, "Preuve aléatoire manquée");
      pendingProofs.delete(message.id);
    }
  }, 30 * 60 * 1000);

  pendingProofs.set(message.id, { timeout, reminder });
}

async function sendCheckin(hour) {
  const channel = await client.channels.fetch(ANNONCES_CHANNEL_ID);
  if (!channel) return;

  const displayHour = `${hour}h`;

  const button = new ButtonBuilder()
    .setCustomId(`checkin_${hour}`)
    .setLabel('Je suis là')
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(button);

  const message = await channel.send({
    content: `**Contrôle de connexion – ${displayHour}**\nClique sur le bouton pour confirmer ta présence.`,
    components: [row]
  });

  setTimeout(async () => {
    try {
      const fetched = await channel.messages.fetch(message.id);
      if (fetched.components.length > 0) {
        await fetched.edit({
          content: `❌ **Contrôle de connexion manqué – ${displayHour}**`,
          components: []
        });
        await addWarning(channel.guild, `Contrôle de connexion manqué (${displayHour})`);
      }
    } catch (err) {
      console.error(err);
    }
  }, 30 * 60 * 1000);
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('checkin_')) return;

  const hour = interaction.customId.split('_')[1];
  const displayHour = `${hour}h`;

  await interaction.update({
    content: `✅ **Contrôle de connexion validé – ${displayHour}**`,
    components: []
  });

  await axios.post(APPS_SCRIPT_URL, {
    type: "checkin",
    heure_prevue: displayHour,
    statut: "Validé"
  });
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  if (message.author.id === OWNER_ID) {
    if (message.content === '!parole') {
      await setSpeechPermission(message.guild, true);
      await message.reply("🔓 Elle peut maintenant écrire dans #général, #sessions et #punitions.");
      return;
    }

    if (message.content === '!silence') {
      await setSpeechPermission(message.guild, false);
      await message.reply("🔇 Silence. Elle ne peut plus écrire dans #général, #sessions et #punitions.");
      return;
    }

    if (message.content === '!taches') {
      await postDailyTasks();
      return;
    }

    if (message.content === '!testavertissement') {
      await addWarning(message.guild, "Test manuel");
      await message.reply("Avertissement de test ajouté.");
      return;
    }
  }

  if (message.channel.id === JOURNAL_CHANNEL_ID || message.channel.id === RETOURS_CHANNEL_ID) {
    await message.react('✅');
  }

  if (message.channel.id === DEMANDES_CHANNEL_ID) {
    const content = message.content;
    const hasDemande = /demande\s*:/i.test(content);
    const hasRaison = /raison\s*:/i.test(content);
    const hasUrgence = /urgence\s*:/i.test(content);

    if (hasDemande && hasRaison && hasUrgence) {
      await axios.post(APPS_SCRIPT_URL, {
        type: "demande",
        contenu: message.content,
        lienOui: `${APPS_SCRIPT_URL}?action=oui&msg=${encodeURIComponent(message.content)}`,
        lienNon: `${APPS_SCRIPT_URL}?action=non&msg=${encodeURIComponent(message.content)}`
      });
      await message.react('✅');
      await message.reply("✅ **Demande envoyée.** Tu recevras une réponse.");
    } else {
      await message.react('❌');
      await message.reply("❌ **Format incorrect.**\n\n**Format attendu :**\nDemande : [ce que tu demandes]\nRaison : [pourquoi]\nUrgence : [urgent / normal / peu urgent]");
    }
  }

  if (message.content === '!avertissements') {
    const count = getRecentWarnings();
    await message.reply(`Avertissements sur les dernières 24h : **${count}**`);
    return;
  }

  if (message.channel.id === PREUVES_CHANNEL_ID && pendingProofs.size > 0) {
    const content = message.content.trim();
    const hasAttachment = message.attachments.size > 0;
    const hasCorrectFormat = content.toLowerCase().startsWith('preuve -');

    if (hasCorrectFormat && hasAttachment) {
      await message.react('✅');
      const annonces = await client.channels.fetch(ANNONCES_CHANNEL_ID);
      await annonces.send(`✅ **Preuve reçue**`);

      const taskName = content.substring(8).trim();
      const fileUrls = message.attachments.map(att => att.url).join('\n');

      await axios.post(APPS_SCRIPT_URL, {
        type: "preuve",
        tache: taskName || "Non précisé",
        statut: "Validée",
        fichiers: fileUrls
      });

      for (const [id, data] of pendingProofs) {
        clearTimeout(data.timeout);
        clearTimeout(data.reminder);
        pendingProofs.delete(id);
      }
    } else {
      await message.react('❌');
      let errorMsg = "❌ **Preuve refusée.**\n";
      if (!hasCorrectFormat) errorMsg += "- Le message doit commencer par `Preuve - [nom]`\n";
      if (!hasAttachment) errorMsg += "- Tu dois joindre au moins un fichier";
      await message.reply(errorMsg);
    }
  }
});

client.login(process.env.TOKEN);
