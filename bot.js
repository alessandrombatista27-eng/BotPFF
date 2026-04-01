const {
  Client, GatewayIntentBits, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ButtonBuilder,
  ButtonStyle, PermissionFlagsBits, REST, Routes,
} = require('discord.js');

const { google } = require('googleapis');
const fs = require('fs');

// ── Arquivo de persistência dos Emergency Signs ───────────────────────────
const ES_FILE = './emergency_signs.json';

function carregarES() {
  try {
    if (fs.existsSync(ES_FILE)) return JSON.parse(fs.readFileSync(ES_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function salvarES(data) {
  fs.writeFileSync(ES_FILE, JSON.stringify(data, null, 2));
}

function getESRestantes(roleId) {
  const data = carregarES();
  if (data[roleId] === undefined) return 2;
  return data[roleId];
}

function usarES(roleId) {
  const data = carregarES();
  if (data[roleId] === undefined) data[roleId] = 2;
  if (data[roleId] <= 0) return false;
  data[roleId]--;
  salvarES(data);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
const CONFIG = {
  TOKEN:                        process.env.TOKEN,
  CLIENT_ID:                    process.env.CLIENT_ID,
  CHANNEL_ID:                   process.env.CHANNEL_ID,
  CONTRACT_CHANNEL_ID:          process.env.CONTRACT_CHANNEL_ID,
  CONTRACT_ACCEPTED_CHANNEL_ID: process.env.CONTRACT_ACCEPTED_CHANNEL_ID || '',
  SCOUTING_CHANNEL_ID:          process.env.SCOUTING_CHANNEL_ID,
  CONTRACT_ROLE_ID:             process.env.CONTRACT_ROLE_ID,
  SCOUTING_ROLE_ID:             process.env.SCOUTING_ROLE_ID,
  MANAGER_ROLE_ID:              process.env.MANAGER_ROLE_ID || process.env.SCOUTING_ROLE_ID || '',
  EMBED_COLOR:                  parseInt(process.env.EMBED_COLOR),
  SPREADSHEET_ID:               process.env.SPREADSHEET_ID,
  SHEET_RANGE:                  process.env.SHEET_RANGE,
  ALLOWED_TEAM_ROLES:           (process.env.ALLOWED_TEAM_ROLES || '').split(',').filter(Boolean),
  AGENCY_ADMIN_ROLES:           (process.env.AGENCY_ADMIN_ROLES || '').split(',').filter(Boolean),
};

const MAX_SQUAD_SIZE   = 14;
const MAX_ES_PER_TEAM  = 2;
let agencyAberta = true;

const FREEAGENCY_COOLDOWN_MS = 15 * 60 * 1000;
const freeAgencyCooldowns    = new Map();

function formatarLibras(valor) {
  if (!valor) return 'N/A';
  const numero = parseFloat(valor.toString().replace(/[^0-9.]/g, ''));
  if (isNaN(numero)) return 'N/A';
  return `£ ${Math.round(numero).toLocaleString('en-GB')}`;
}

async function buscarJogadorNaPlanilha(usernameRoblox) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets   = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: CONFIG.SHEET_RANGE,
  });
  const rows = response.data.values;
  if (!rows || rows.length === 0) return null;

  const IDX_TIER = 0, IDX_OVERALL = 2, IDX_USERNAME = 8, IDX_WAGE = 9;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row[IDX_USERNAME]) continue;
    if (row[IDX_USERNAME].trim().toLowerCase() === usernameRoblox.trim().toLowerCase()) {
      return {
        username: row[IDX_USERNAME],
        tier:     (row[IDX_TIER] || '').trim().toUpperCase(),
        overall:  parseInt(row[IDX_OVERALL], 10) || null,
        wage:     row[IDX_WAGE] || null,
      };
    }
  }
  return null;
}

async function buscarAvatarRoblox(usernameRoblox) {
  try {
    const userRes  = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [usernameRoblox], excludeBannedUsers: false }),
    });
    const userData = await userRes.json();
    if (!userData.data || userData.data.length === 0) return null;
    const userId   = userData.data[0].id;
    const thumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
    const thumbData = await thumbRes.json();
    if (!thumbData.data || thumbData.data.length === 0) return null;
    return thumbData.data[0].imageUrl;
  } catch { return null; }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: ['CHANNEL'],
});

async function registrarComandos() {
  const commands = [
    new SlashCommandBuilder()
      .setName('freeagency')
      .setDescription('📋 Cadastre-se como jogador disponível (Free Agent)')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('removefa')
      .setDescription('❌ Remove seu anúncio de Free Agent')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('contract')
      .setDescription('📝 Envia uma proposta de contratação para um jogador')
      .addUserOption(o => o.setName('jogador').setDescription('Usuário do Discord do jogador').setRequired(true))
      .addRoleOption(o => o.setName('time').setDescription('Cargo do time que está contratando').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('scouting')
      .setDescription('🔍 Abre um recrutamento para buscar jogadores')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('removescouting')
      .setDescription('🗑️ Remove seu anúncio de scouting ativo')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('fecharagency')
      .setDescription('🔒 Fecha o sistema de Free Agency')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('abriragency')
      .setDescription('🔓 Abre o sistema de Free Agency')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('squadsheet')
      .setDescription('📋 Mostra o elenco de um time')
      .addRoleOption(o => o.setName('time').setDescription('Cargo do time').setRequired(true))
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(CONFIG.TOKEN);
  try {
    console.log('🔄 Registrando comandos slash...');
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
    console.log('✅ Comandos registrados!');
  } catch (error) {
    console.error('❌ Erro ao registrar comandos:', error);
  }
}

const freeAgents        = new Map();
const pendingContracts  = new Map();
const scoutings         = new Map();
// Contratos pendentes de Emergency Sign: managerId => contractData
const pendingES         = new Map();

client.once('ready', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  await registrarComandos();
});

client.on('interactionCreate', async (interaction) => {

  // ── /freeagency ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'freeagency') {
    if (!agencyAberta) {
      return interaction.reply({ content: '🔒 O sistema de Free Agency está fechado no momento.', flags: 64 });
    }

    const agora         = Date.now();
    const ultimoUso     = freeAgencyCooldowns.get(interaction.user.id) || 0;
    const tempoRestante = FREEAGENCY_COOLDOWN_MS - (agora - ultimoUso);

    if (tempoRestante > 0) {
      const minutos  = Math.floor(tempoRestante / 60000);
      const segundos = Math.floor((tempoRestante % 60000) / 1000);
      return interaction.reply({
        content: `⏳ Você está em cooldown! Aguarde **${minutos}m ${segundos}s** para usar o comando novamente.`,
        flags: 64,
      });
    }

    if (freeAgents.has(interaction.user.id)) {
      return interaction.reply({ content: '⚠️ Você já possui um anúncio ativo! Use `/removefa` para remover antes de criar um novo.', flags: 64 });
    }

    const modal = new ModalBuilder().setCustomId('modal_freeagency').setTitle('📋 Cadastro de Free Agent');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roblox').setLabel('Usuário do Roblox').setStyle(TextInputStyle.Short).setPlaceholder('ex: mrgroove').setRequired(true).setMaxLength(50)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('posicao').setLabel('Posição').setStyle(TextInputStyle.Short).setPlaceholder('ex: Qualquer Posição ou Goleiro (GK)').setRequired(true).setMaxLength(60)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('experiencia').setLabel('Experiência (ligas/times)').setStyle(TextInputStyle.Short).setPlaceholder('ex: EMF, IFC, CBM S4/S5').setRequired(false).setMaxLength(100)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sobremim').setLabel('Sobre Mim (opcional)').setStyle(TextInputStyle.Paragraph).setPlaceholder('ex: feliz, disponível nos fins de semana...').setRequired(false).setMaxLength(200)),
    );
    await interaction.showModal(modal);
  }

  // ── /removefa ────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'removefa') {
    const entry = freeAgents.get(interaction.user.id);
    if (!entry) return interaction.reply({ content: '⚠️ Você não possui nenhum anúncio ativo.', flags: 64 });
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const msg     = await channel.messages.fetch(entry.messageId);
      await msg.delete();
    } catch (_) {}
    freeAgents.delete(interaction.user.id);
    return interaction.reply({ content: '✅ Seu anúncio de Free Agent foi removido!', flags: 64 });
  }

  // ── /scouting ────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'scouting') {
    if (CONFIG.SCOUTING_ROLE_ID && !interaction.member.roles.cache.has(CONFIG.SCOUTING_ROLE_ID)) {
      return interaction.reply({ content: '⛔ Você não tem permissão para abrir um recrutamento.', flags: 64 });
    }
    if (scoutings.has(interaction.user.id)) {
      return interaction.reply({ content: '⚠️ Você já possui um recrutamento ativo! Use `/removescouting` para remover antes.', flags: 64 });
    }
    const modal = new ModalBuilder().setCustomId('modal_scouting').setTitle('🔍 Abrir Recrutamento');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Time').setStyle(TextInputStyle.Short).setPlaceholder('ex: Manchester City').setRequired(true).setMaxLength(60)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('liga').setLabel('Liga').setStyle(TextInputStyle.Short).setPlaceholder('ex: Master League').setRequired(true).setMaxLength(60)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('posicao').setLabel('Posição Buscada').setStyle(TextInputStyle.Short).setPlaceholder('ex: GK - Goleiro').setRequired(true).setMaxLength(60)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('requisitos').setLabel('Requisitos').setStyle(TextInputStyle.Paragraph).setPlaceholder('ex: Ter classe alta, saber jogar no pitch...').setRequired(true).setMaxLength(300)),
    );
    await interaction.showModal(modal);
  }

  // ── /removescouting ──────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'removescouting') {
    const entry = scoutings.get(interaction.user.id);
    if (!entry) return interaction.reply({ content: '⚠️ Você não possui nenhum recrutamento ativo.', flags: 64 });
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const msg     = await channel.messages.fetch(entry.messageId);
      await msg.delete();
    } catch (_) {}
    scoutings.delete(interaction.user.id);
    return interaction.reply({ content: '✅ Seu recrutamento foi removido!', flags: 64 });
  }

  // ── /contract ────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'contract') {
    if (!interaction.member.roles.cache.has(CONFIG.CONTRACT_ROLE_ID)) {
      return interaction.reply({ content: '⛔ Você não tem permissão para usar este comando.', flags: 64 });
    }

    const targetUser = interaction.options.getUser('jogador');
    const teamRole   = interaction.options.getRole('time');

    if (CONFIG.ALLOWED_TEAM_ROLES.length > 0 && !CONFIG.ALLOWED_TEAM_ROLES.includes(teamRole.id)) {
      return interaction.reply({ content: '⛔ Este cargo não é válido para contratações.', flags: 64 });
    }
    if (targetUser.bot)                       return interaction.reply({ content: '⛔ Você não pode enviar uma proposta para um bot.', flags: 64 });
    if (targetUser.id === interaction.user.id) return interaction.reply({ content: '⛔ Você não pode enviar uma proposta para si mesmo.', flags: 64 });

    await interaction.guild.members.fetch();
    const membrosDoTime  = interaction.guild.members.cache.filter(m => m.roles.cache.has(teamRole.id) && !m.user.bot);
    const totalNoTime    = membrosDoTime.size;
    const esRestantes    = getESRestantes(teamRole.id);
    const limiteMaximo   = MAX_SQUAD_SIZE + MAX_ES_PER_TEAM;

    // Time completamente cheio (14 + 2 ES usados)
    if (totalNoTime >= limiteMaximo) {
      return interaction.reply({
        content: `🚫 O time **${teamRole.name}** está completamente cheio! (**${totalNoTime}/${limiteMaximo}**)\nTodos os Emergency Signs já foram utilizados.`,
        flags: 64,
      });
    }

    // Time cheio mas ainda tem ES disponível — perguntar ao manager
    if (totalNoTime >= MAX_SQUAD_SIZE) {
      if (esRestantes <= 0) {
        return interaction.reply({
          content: `🚫 O time **${teamRole.name}** está cheio e não possui mais Emergency Signs disponíveis.`,
          flags: 64,
        });
      }

      // Guardar dados do contrato pendente de ES
      pendingES.set(interaction.user.id, {
        targetUserId: targetUser.id,
        managerId:    interaction.user.id,
        guildId:      interaction.guild.id,
        teamRole:     teamRole.name,
        teamRoleId:   teamRole.id,
        totalNoTime,
        esRestantes,
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`es_aceitar_${interaction.user.id}`).setLabel(`✅ Usar Emergency Sign (${esRestantes} restante${esRestantes > 1 ? 's' : ''})`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`es_cancelar_${interaction.user.id}`).setLabel('❌ Cancelar').setStyle(ButtonStyle.Secondary),
      );

      return interaction.reply({
        content: `⚠️ **O elenco de ${teamRole.name} já está cheio! (${totalNoTime}/${MAX_SQUAD_SIZE})**\n\n🚨 **Emergency Sign disponível!**\nSeu time possui **${esRestantes}** Emergency Sign${esRestantes > 1 ? 's' : ''} restante${esRestantes > 1 ? 's' : ''}.\n\nDeseja usar um Emergency Sign para contratar mesmo assim?`,
        components: [row],
        flags: 64,
      });
    }

    // Normal — dentro do limite
    await interaction.deferReply({ flags: 64 });
    await enviarProposta(interaction, targetUser, teamRole, totalNoTime);
  }

  // ── BOTÃO: aceitar Emergency Sign ────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('es_aceitar_')) {
    const managerId  = interaction.customId.replace('es_aceitar_', '');
    if (interaction.user.id !== managerId) {
      return interaction.reply({ content: '⛔ Apenas o Manager que iniciou o comando pode confirmar.', flags: 64 });
    }

    const esData = pendingES.get(managerId);
    if (!esData) return interaction.reply({ content: '⚠️ Esta ação já foi processada ou expirou.', flags: 64 });

    const usado = usarES(esData.teamRoleId);
    if (!usado) {
      return interaction.reply({ content: '🚫 Não há mais Emergency Signs disponíveis para este time.', flags: 64 });
    }

    pendingES.delete(managerId);

    const targetUser = await client.users.fetch(esData.targetUserId);
    const teamRole   = await interaction.guild.roles.fetch(esData.teamRoleId);
    const esRestantes = getESRestantes(esData.teamRoleId);

    await interaction.update({ content: `✅ Emergency Sign utilizado! **${esRestantes} restante${esRestantes !== 1 ? 's' : ''}** para ${teamRole.name}.\nEnviando proposta para ${targetUser}...`, components: [] });

    await enviarProposta(interaction, targetUser, teamRole, esData.totalNoTime, true);
  }

  // ── BOTÃO: cancelar Emergency Sign ───────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('es_cancelar_')) {
    const managerId = interaction.customId.replace('es_cancelar_', '');
    if (interaction.user.id !== managerId) {
      return interaction.reply({ content: '⛔ Apenas o Manager que iniciou o comando pode cancelar.', flags: 64 });
    }
    pendingES.delete(managerId);
    return interaction.update({ content: '❌ Contratação cancelada.', components: [] });
  }

  // ── /fecharagency ────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'fecharagency') {
    const temPermissao = CONFIG.AGENCY_ADMIN_ROLES.some(r => interaction.member.roles.cache.has(r));
    if (!temPermissao) return interaction.reply({ content: '⛔ Você não tem permissão para usar este comando.', flags: 64 });
    if (!agencyAberta) return interaction.reply({ content: '⚠️ O sistema de Free Agency já está fechado.', flags: 64 });
    agencyAberta = false;
    return interaction.reply({ content: '🔒 Sistema de Free Agency **fechado** com sucesso!' });
  }

  // ── /abriragency ─────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'abriragency') {
    const temPermissao = CONFIG.AGENCY_ADMIN_ROLES.some(r => interaction.member.roles.cache.has(r));
    if (!temPermissao) return interaction.reply({ content: '⛔ Você não tem permissão para usar este comando.', flags: 64 });
    if (agencyAberta)  return interaction.reply({ content: '⚠️ O sistema de Free Agency já está aberto.', flags: 64 });
    agencyAberta = true;
    return interaction.reply({ content: '🔓 Sistema de Free Agency **aberto** com sucesso!' });
  }

  // ── /squadsheet ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'squadsheet') {
    const teamRole = interaction.options.getRole('time');
    await interaction.deferReply();

    try { await interaction.guild.members.fetch(); } catch (_) {}

    const membros = interaction.guild.members.cache.filter(m => m.roles.cache.has(teamRole.id) && !m.user.bot);

    if (membros.size === 0) {
      return interaction.editReply({ content: `⚠️ Nenhum membro encontrado com o cargo ${teamRole}.` });
    }

    const managers = [];
    const players  = [];

    membros.forEach(m => {
      if (CONFIG.MANAGER_ROLE_ID && m.roles.cache.has(CONFIG.MANAGER_ROLE_ID)) {
        managers.push(m);
      } else {
        players.push(m);
      }
    });

    const total       = membros.size;
    const esRestantes = getESRestantes(teamRole.id);
    const vagas       = MAX_SQUAD_SIZE - total;
    const usouES      = total > MAX_SQUAD_SIZE;

    let lista = '';
    managers.forEach(m => { lista += `💼 **[M]** ${m.user.username}\n`; });
    players.forEach(m  => { lista += `⚽ **[P]** ${m.user.username}\n`; });

    let statusCor  = 0x57F287;
    let statusText = `**${total}** / ${MAX_SQUAD_SIZE} — ${vagas > 0 ? `${vagas} vaga${vagas > 1 ? 's' : ''} restante${vagas > 1 ? 's' : ''}` : '🔴 Elenco cheio!'}`;

    if (total >= MAX_SQUAD_SIZE + MAX_ES_PER_TEAM) {
      statusCor  = 0xED4245;
      statusText = `**${total}** / ${MAX_SQUAD_SIZE} — 🚫 Elenco completamente cheio!`;
    } else if (total >= MAX_SQUAD_SIZE) {
      statusCor  = 0xED4245;
      statusText = `**${total}** / ${MAX_SQUAD_SIZE} — 🚨 Emergency Sign${esRestantes > 0 ? `s: **${esRestantes}** restante${esRestantes > 1 ? 's' : ''}` : 's esgotados!'}`;
    } else if (total >= 12) {
      statusCor = 0xFEE75C;
    }

    const embed = new EmbedBuilder()
      .setColor(statusCor)
      .setAuthor({ name: `📋 Elenco — ${teamRole.name}`, iconURL: interaction.guild.iconURL({ dynamic: true }) })
      .setDescription(lista)
      .addFields(
        { name: '👥 Elenco', value: statusText, inline: false },
        { name: '🚨 Emergency Signs', value: `${esRestantes} / ${MAX_ES_PER_TEAM} disponíve${esRestantes !== 1 ? 'is' : 'l'}`, inline: true },
      )
      .setFooter({ text: `1 Manager + até 13 Players • Máx. ${MAX_SQUAD_SIZE} + ${MAX_ES_PER_TEAM} Emergency Signs` })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  // ── MODAL: freeagency ────────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'modal_freeagency') {
    const roblox      = interaction.fields.getTextInputValue('roblox').trim();
    const posicao     = interaction.fields.getTextInputValue('posicao').trim();
    const experiencia = interaction.fields.getTextInputValue('experiencia').trim();
    const sobreMim    = interaction.fields.getTextInputValue('sobremim').trim();

    await interaction.deferReply({ flags: 64 });

    let tier = 'N/A', overall = 'N/A', avatarUrl = null;

    try {
      const dados = await buscarJogadorNaPlanilha(roblox);
      if (dados) { tier = dados.tier || 'N/A'; overall = dados.overall || 'N/A'; }
    } catch (err) { console.error('❌ Erro ao consultar Google Sheets:', err); }

    avatarUrl = await buscarAvatarRoblox(roblox);

    const tierEmoji = { S: '🟡', A: '🟠', B: '🟢', C: '🔵', D: '⚪', E: '🔴', F: '⚫' };
    const emoji     = tierEmoji[tier] || '⚪';

    const embed = new EmbedBuilder()
      .setColor(CONFIG.EMBED_COLOR)
      .setAuthor({ name: '🟢 Jogador Disponível', iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
      .setThumbnail(avatarUrl)
      .setDescription(`👤 **Jogador**\n**Discord:** ${interaction.user}\n**Roblox:** \`${roblox}\``)
      .addFields(
        { name: '⚙️ Posição',     value: posicao || 'Qualquer Posição', inline: false },
        { name: '📊 Estatísticas', value: `Tier: ${tier === 'N/A' ? '⚪ **N/A**' : `${emoji} **${tier}**`}\nOverall: **${overall}**`, inline: true },
        ...(experiencia ? [{ name: '📋 Experiência', value: experiencia, inline: false }] : []),
        ...(sobreMim    ? [{ name: '📝 Sobre Mim',   value: sobreMim,    inline: false }] : []),
      )
      .setFooter({ text: `ID: ${interaction.user.id}` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`btn_remove_${interaction.user.id}`).setLabel('❌ Remover Anúncio').setStyle(ButtonStyle.Danger),
    );

    try {
      const channel = await client.channels.fetch(CONFIG.CHANNEL_ID);
      const msg     = await channel.send({ embeds: [embed], components: [row] });
      freeAgents.set(interaction.user.id, { messageId: msg.id, channelId: msg.channelId });
      freeAgencyCooldowns.set(interaction.user.id, Date.now());
      await interaction.editReply({
        content: `✅ Anúncio publicado em <#${CONFIG.CHANNEL_ID}>!\n📊 Tier: **${tier}** | Overall: **${overall}**\n⏳ Você poderá usar o comando novamente em **15 minutos**.`,
      });
    } catch (err) {
      console.error('Erro ao enviar embed:', err);
      await interaction.editReply({ content: '❌ Erro ao publicar o anúncio. Verifique as permissões do bot no canal.' });
    }
  }

  // ── MODAL: scouting ──────────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'modal_scouting') {
    const time       = interaction.fields.getTextInputValue('time').trim();
    const liga       = interaction.fields.getTextInputValue('liga').trim();
    const posicao    = interaction.fields.getTextInputValue('posicao').trim();
    const requisitos = interaction.fields.getTextInputValue('requisitos').trim();

    await interaction.deferReply({ flags: 64 });

    const embed = new EmbedBuilder()
      .setColor(0xFEE75C)
      .setAuthor({ name: '🔎 Recrutamento Aberto', iconURL: interaction.guild.iconURL({ dynamic: true }) })
      .addFields(
        { name: '🏆 Time',            value: time,       inline: false },
        { name: '🏅 Liga',            value: liga,       inline: false },
        { name: '⚙️ Posição Buscada', value: posicao,    inline: false },
        { name: '📋 Requisitos',      value: requisitos, inline: false },
        { name: '🔍 Recrutador',      value: `${interaction.user} (${interaction.user.username})`, inline: false },
      )
      .setFooter({ text: `ID: ${interaction.user.id}` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`btn_remove_scouting_${interaction.user.id}`).setLabel('🗑️ Encerrar Recrutamento').setStyle(ButtonStyle.Danger),
    );

    const scoutingChannelId = CONFIG.SCOUTING_CHANNEL_ID || CONFIG.CHANNEL_ID;
    try {
      const channel = await client.channels.fetch(scoutingChannelId);
      const msg     = await channel.send({ embeds: [embed], components: [row] });
      scoutings.set(interaction.user.id, { messageId: msg.id, channelId: msg.channelId });
      await interaction.editReply({ content: `✅ Recrutamento publicado em <#${scoutingChannelId}>!` });
    } catch (err) {
      console.error('Erro ao enviar embed de scouting:', err);
      await interaction.editReply({ content: '❌ Erro ao publicar o recrutamento.' });
    }
  }

  // ── BOTÃO ACEITAR CONTRATO ───────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('contract_accept_')) {
    const parts         = interaction.customId.split('_');
    const allowedUserId = parts[2];

    if (interaction.user.id !== allowedUserId) {
      return interaction.reply({ content: '⛔ Apenas o jogador mencionado na proposta pode aceitar.', flags: 64 });
    }

    const contractData = pendingContracts.get(interaction.message.id);
    if (!contractData) return interaction.reply({ content: '⚠️ Esta proposta já foi processada ou expirou.', flags: 64 });

    const modal = new ModalBuilder()
      .setCustomId(`modal_accept_contract_${interaction.message.id}`)
      .setTitle('✅ Aceitar Contratação');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('roblox').setLabel('Coloque seu nick do Roblox').setStyle(TextInputStyle.Short).setPlaceholder('ex: mrgroove').setRequired(true).setMaxLength(50)
      ),
    );
    await interaction.showModal(modal);
  }

  // ── MODAL: aceitar contrato ──────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_accept_contract_')) {
    const messageId    = interaction.customId.replace('modal_accept_contract_', '');
    const roblox       = interaction.fields.getTextInputValue('roblox').trim();
    const contractData = pendingContracts.get(messageId);

    if (!contractData) return interaction.reply({ content: '⚠️ Esta proposta já foi processada ou expirou.', flags: 64 });

    await interaction.deferReply({ flags: 64 });

    let tier = 'N/A', overall = 'N/A', wage = null, avatarUrl = null;

    try {
      const dados = await buscarJogadorNaPlanilha(roblox);
      if (dados) { tier = dados.tier || 'N/A'; overall = dados.overall || 'N/A'; wage = dados.wage; }
    } catch (err) { console.error('❌ Erro ao consultar Google Sheets:', err); }

    avatarUrl = await buscarAvatarRoblox(roblox);

    const tierEmoji = { S: '🟡', A: '🟠', B: '🟢', C: '🔵', D: '⚪', E: '🔴', F: '⚫' };
    const emoji   = tierEmoji[tier] || '⚪';
    const salario = formatarLibras(wage);

    // ── Dar o cargo do time ao jogador ──
    try {
      const guild  = await client.guilds.fetch(contractData.guildId);
      const membro = await guild.members.fetch(contractData.targetUserId);
      await membro.roles.add(contractData.teamRoleId);
      console.log(`✅ Cargo ${contractData.teamRole} adicionado para ${membro.user.tag}`);
    } catch (err) {
      console.error('❌ Erro ao adicionar cargo:', err);
    }

    const acceptedEmbedDM = new EmbedBuilder()
      .setColor(0x57F287)
      .setAuthor({ name: '🤝 Contratação Confirmada!' })
      .setThumbnail(avatarUrl)
      .setDescription(`**Roblox:** \`${roblox}\`\n**Time:** ${contractData.teamRole}`)
      .addFields({ name: '📊 Dados', value: `Tier: ${tier === 'N/A' ? '⚪ **N/A**' : `${emoji} **${tier}**`}\nOVR: **${overall}**\nWage: **${salario}**`, inline: false })
      .setFooter({ text: `✅ Você aceitou a proposta!${contractData.isES ? ' (Emergency Sign)' : ''}` })
      .setTimestamp();

    try { await interaction.message.edit({ content: null, embeds: [acceptedEmbedDM], components: [] }); } catch (_) {}

    const guild    = await client.guilds.fetch(contractData.guildId);
    const manager  = await client.users.fetch(contractData.managerId);
    const teamRole = await guild.roles.fetch(contractData.teamRoleId);

    const acceptedEmbedChannel = new EmbedBuilder()
      .setColor(contractData.isES ? 0xFEE75C : 0x57F287)
      .setAuthor({ name: `📥 Contratação${contractData.isES ? ' 🚨 Emergency Sign' : ''}`, iconURL: guild.iconURL({ dynamic: true }) })
      .setThumbnail(avatarUrl)
      .setDescription(`♦️ **Jogador**\n**Discord:** ${interaction.user}\n**Roblox:** \`${roblox}\``)
      .addFields(
        { name: '🏆 Time',  value: `${teamRole}`, inline: false },
        { name: '📋 Dados', value: `Tier: ${tier === 'N/A' ? '⚪ **N/A**' : `${emoji} **${tier}**`}\nOVR: **${overall}**\nSalário: **${salario}**`, inline: false },
      )
      .setFooter({ text: `✅ Contratado por ${manager.tag}` })
      .setTimestamp();

    try {
      const channelId = CONFIG.CONTRACT_ACCEPTED_CHANNEL_ID || CONFIG.CONTRACT_CHANNEL_ID;
      const channel   = await client.channels.fetch(channelId);
      await channel.send({ embeds: [acceptedEmbedChannel] });
    } catch (err) { console.error('Erro ao enviar no canal de contratos aceitos:', err); }

    pendingContracts.delete(messageId);

    const faEntry = freeAgents.get(contractData.targetUserId);
    if (faEntry) {
      try {
        const faChannel = await client.channels.fetch(faEntry.channelId);
        const faMsg     = await faChannel.messages.fetch(faEntry.messageId);
        await faMsg.delete();
      } catch (_) {}
      freeAgents.delete(contractData.targetUserId);
    }

    return interaction.editReply({ content: '✅ Você aceitou a proposta! O cargo do time foi adicionado automaticamente.' });
  }

  // ── BOTÃO RECUSAR CONTRATO ───────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('contract_decline_')) {
    const allowedUserId = interaction.customId.split('_')[2];
    if (interaction.user.id !== allowedUserId) {
      return interaction.reply({ content: '⛔ Apenas o jogador mencionado na proposta pode recusar.', flags: 64 });
    }
    const contractData = pendingContracts.get(interaction.message.id);
    if (!contractData) return interaction.reply({ content: '⚠️ Esta proposta já foi processada ou expirou.', flags: 64 });

    const declinedEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setAuthor({ name: '❌ Proposta Recusada' })
      .setDescription(`**Time:** ${contractData.teamRole}`)
      .setFooter({ text: '❌ Você recusou esta proposta.' })
      .setTimestamp();

    await interaction.message.edit({ content: null, embeds: [declinedEmbed], components: [] });
    pendingContracts.delete(interaction.message.id);

    try {
      const manager = await client.users.fetch(contractData.managerId);
      await manager.send({ content: `❌ **Proposta recusada!**\n${interaction.user} recusou a proposta para o time **${contractData.teamRole}**.` });
    } catch (_) {}

    // Se era ES, devolver o ES
    if (contractData.isES) {
      const data = carregarES();
      if (data[contractData.teamRoleId] !== undefined) {
        data[contractData.teamRoleId] = Math.min(data[contractData.teamRoleId] + 1, MAX_ES_PER_TEAM);
        salvarES(data);
      }
    }

    return interaction.reply({ content: '❌ Você recusou a proposta de contratação.', flags: 64 });
  }

  // ── BOTÃO REMOVER FREE AGENT ─────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('btn_remove_') && !interaction.customId.startsWith('btn_remove_scouting_')) {
    const ownerId = interaction.customId.replace('btn_remove_', '');
    const isOwner = interaction.user.id === ownerId;
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageMessages);
    if (!isOwner && !isAdmin) return interaction.reply({ content: '⛔ Apenas o dono do anúncio ou um moderador pode removê-lo.', flags: 64 });
    try { await interaction.message.delete(); } catch (_) {}
    freeAgents.delete(ownerId);
    return interaction.reply({ content: '✅ Anúncio removido com sucesso!', flags: 64 });
  }

  // ── BOTÃO ENCERRAR SCOUTING ──────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('btn_remove_scouting_')) {
    const ownerId = interaction.customId.replace('btn_remove_scouting_', '');
    const isOwner = interaction.user.id === ownerId;
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageMessages);
    if (!isOwner && !isAdmin) return interaction.reply({ content: '⛔ Apenas o recrutador ou um moderador pode encerrar este recrutamento.', flags: 64 });
    try { await interaction.message.delete(); } catch (_) {}
    scoutings.delete(ownerId);
    return interaction.reply({ content: '✅ Recrutamento encerrado com sucesso!', flags: 64 });
  }
});

// ── Função auxiliar: enviar proposta de contratação ───────────────────────
async function enviarProposta(interaction, targetUser, teamRole, totalNoTime, isES = false) {
  const vagasRestantes = MAX_SQUAD_SIZE - totalNoTime;

  const embed = new EmbedBuilder()
    .setColor(isES ? 0xFEE75C : 0x57F287)
    .setAuthor({
      name: `📝 Proposta de Contratação${isES ? ' 🚨 Emergency Sign' : ''}`,
      iconURL: interaction.guild ? interaction.guild.iconURL({ dynamic: true }) : undefined,
    })
    .setDescription(`**Time:** ${teamRole}\n**Enviado por:** <@${interaction.user.id}>`)
    .setFooter({ text: `⏳ Aguardando sua resposta...${isES ? ' • Emergency Sign' : ` • ${Math.max(0, vagasRestantes - 1)} vagas restantes após esta`}` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`contract_accept_${targetUser.id}_${interaction.guildId}`).setLabel('✅ Aceitar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`contract_decline_${targetUser.id}_${interaction.guildId}`).setLabel('❌ Recusar').setStyle(ButtonStyle.Danger),
  );

  try {
    const dmMessage = await targetUser.send({
      content: `🔔 **Você recebeu uma proposta de contratação!**`,
      embeds: [embed],
      components: [row],
    });

    pendingContracts.set(dmMessage.id, {
      targetUserId: targetUser.id,
      managerId:    interaction.user.id,
      guildId:      interaction.guildId,
      teamRole:     teamRole.name,
      teamRoleId:   teamRole.id,
      isES,
    });

    const replyContent = isES
      ? `✅ Proposta enviada para ${targetUser} via DM usando **Emergency Sign**!`
      : `✅ Proposta enviada para ${targetUser} via DM! Time: ${teamRole}\n👥 Time com **${totalNoTime}/${MAX_SQUAD_SIZE}** jogadores.`;

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: replyContent });
    } else {
      await interaction.followUp({ content: replyContent, flags: 64 });
    }
  } catch (err) {
    console.error('Erro ao enviar DM:', err);
    const errMsg = `❌ Não foi possível enviar a proposta para ${targetUser}.\n⚠️ O jogador pode estar com as DMs fechadas.`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: errMsg });
    } else {
      await interaction.followUp({ content: errMsg, flags: 64 });
    }
  }
}

client.login(CONFIG.TOKEN);