const {
  Client, GatewayIntentBits, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ButtonBuilder,
  ButtonStyle, PermissionFlagsBits, REST, Routes,
} = require('discord.js');

const { google } = require('googleapis');

const CONFIG = {
  TOKEN: process.env.TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  CHANNEL_ID: process.env.CHANNEL_ID,
  CONTRACT_CHANNEL_ID: process.env.CONTRACT_CHANNEL_ID,
  CONTRACT_ACCEPTED_CHANNEL_ID: process.env.CONTRACT_ACCEPTED_CHANNEL_ID,
  CONTRACT_ROLE_ID: process.env.CONTRACT_ROLE_ID,
  EMBED_COLOR: parseInt(process.env.EMBED_COLOR),
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  SHEET_RANGE: process.env.SHEET_RANGE,
  ALLOWED_TEAM_ROLES: process.env.ALLOWED_TEAM_ROLES.split(','),
};

function formatarLibras(valor) {
  if (!valor) return 'N/A';
  const numero = parseFloat(valor.toString().replace(/[^0-9.]/g, ''));
  if (isNaN(numero)) return 'N/A';
  const arredondado = Math.round(numero);
  return `£ ${arredondado.toLocaleString('en-GB')}`;
}

async function buscarJogadorNaPlanilha(usernameRoblox) {
  const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: CONFIG.SHEET_RANGE,
  });

  const rows = response.data.values;
  if (!rows || rows.length === 0) return null;

  const IDX_TIER     = 0;
  const IDX_OVERALL  = 2;
  const IDX_USERNAME = 8;
  const IDX_WAGE     = 22;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row[IDX_USERNAME]) continue;
    const usernameNaPlanilha = row[IDX_USERNAME].trim().toLowerCase();
    if (usernameNaPlanilha === usernameRoblox.trim().toLowerCase()) {
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
    const userRes = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [usernameRoblox], excludeBannedUsers: false }),
    });
    const userData = await userRes.json();
    if (!userData.data || userData.data.length === 0) return null;
    const userId = userData.data[0].id;

    const thumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
    const thumbData = await thumbRes.json();
    if (!thumbData.data || thumbData.data.length === 0) return null;
    return thumbData.data[0].imageUrl;
  } catch {
    return null;
  }
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
      .addUserOption(option =>
        option.setName('jogador')
          .setDescription('O usuário do Discord do jogador a ser contratado')
          .setRequired(true))
      .addRoleOption(option =>
        option.setName('time')
          .setDescription('Cargo do time que está contratando')
          .setRequired(true))
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

const freeAgents = new Map();
const pendingContracts = new Map();

client.once('ready', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  await registrarComandos();
});

client.on('interactionCreate', async (interaction) => {

  // ── /freeagency ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'freeagency') {
    if (freeAgents.has(interaction.user.id)) {
      return interaction.reply({
        content: '⚠️ Você já possui um anúncio ativo! Use `/removefa` para remover antes de criar um novo.',
        flags: 64,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId('modal_freeagency')
      .setTitle('📋 Cadastro de Free Agent');

    const robloxInput = new TextInputBuilder()
      .setCustomId('roblox')
      .setLabel('Usuário do Roblox')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('ex: erizin_kk')
      .setRequired(true)
      .setMaxLength(50);

    const posicaoInput = new TextInputBuilder()
      .setCustomId('posicao')
      .setLabel('Posição')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('ex: Qualquer Posição ou Goleiro (GK)')
      .setRequired(true)
      .setMaxLength(60);

    const experienciaInput = new TextInputBuilder()
      .setCustomId('experiencia')
      .setLabel('Experiência (ligas/times)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('ex: EMF, IFC, CBM S4/S5, COL')
      .setRequired(false)
      .setMaxLength(100);

    const sobreMimInput = new TextInputBuilder()
      .setCustomId('sobremim')
      .setLabel('Sobre Mim (opcional)')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('ex: feliz, disponível nos fins de semana...')
      .setRequired(false)
      .setMaxLength(200);

    modal.addComponents(
      new ActionRowBuilder().addComponents(robloxInput),
      new ActionRowBuilder().addComponents(posicaoInput),
      new ActionRowBuilder().addComponents(experienciaInput),
      new ActionRowBuilder().addComponents(sobreMimInput),
    );

    await interaction.showModal(modal);
  }

  // ── /removefa ────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'removefa') {
    const entry = freeAgents.get(interaction.user.id);
    if (!entry) {
      return interaction.reply({
        content: '⚠️ Você não possui nenhum anúncio ativo.',
        flags: 64,
      });
    }
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const msg = await channel.messages.fetch(entry.messageId);
      await msg.delete();
    } catch (_) {}
    freeAgents.delete(interaction.user.id);
    return interaction.reply({
      content: '✅ Seu anúncio de Free Agent foi removido!',
      flags: 64,
    });
  }

  // ── /contract ────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'contract') {
    if (!interaction.member.roles.cache.has(CONFIG.CONTRACT_ROLE_ID)) {
      return interaction.reply({
        content: '⛔ Você não tem permissão para usar este comando.',
        flags: 64,
      });
    }

    const targetUser = interaction.options.getUser('jogador');
    const teamRole = interaction.options.getRole('time');

    // Verificar se o cargo está na lista permitida
    if (!CONFIG.ALLOWED_TEAM_ROLES.includes(teamRole.id)) {
      return interaction.reply({
        content: '⛔ Este cargo não é válido para contratações. Escolha um cargo de time permitido.',
        flags: 64,
      });
    }

    // Verificar se é um bot
    if (targetUser.bot) {
      return interaction.reply({
        content: '⛔ Você não pode enviar uma proposta de contratação para um bot.',
        flags: 64,
      });
    }

    // Verificar se é a própria pessoa
    if (targetUser.id === interaction.user.id) {
      return interaction.reply({
        content: '⛔ Você não pode enviar uma proposta de contratação para si mesmo.',
        flags: 64,
      });
    }

    await interaction.deferReply({ flags: 64 });

    const embed = new EmbedBuilder()
      .setColor(0xFEE75C)
      .setAuthor({
        name: '📝 Proposta de Contratação',
        iconURL: interaction.guild.iconURL({ dynamic: true }),
      })
      .setDescription(`**Time:** ${teamRole}\n**Enviado por:** ${interaction.user}`)
      .setFooter({ text: `⏳ Aguardando sua resposta... • ${interaction.guild.name}` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`contract_accept_${targetUser.id}_${interaction.guild.id}`)
        .setLabel('✅ Aceitar')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`contract_decline_${targetUser.id}_${interaction.guild.id}`)
        .setLabel('❌ Recusar')
        .setStyle(ButtonStyle.Danger),
    );

    try {
      // Envia a proposta na DM do jogador
      const dmMessage = await targetUser.send({
        content: `🔔 **Você recebeu uma proposta de contratação!**`,
        embeds: [embed],
        components: [row],
      });

      pendingContracts.set(dmMessage.id, {
        targetUserId: targetUser.id,
        managerId: interaction.user.id,
        guildId: interaction.guild.id,
        teamRole: teamRole.name,
        teamRoleId: teamRole.id,
      });

      await interaction.editReply({ 
        content: `✅ Proposta enviada para ${targetUser} via **mensagem direta**!\n📩 O jogador receberá a proposta na DM dele para o time ${teamRole}.` 
      });
    } catch (err) {
      console.error('Erro ao enviar DM:', err);
      await interaction.editReply({ 
        content: `❌ Não foi possível enviar a proposta para ${targetUser}.\n⚠️ O jogador pode estar com as DMs fechadas.` 
      });
    }
  }

  // ── MODAL: freeagency ────────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'modal_freeagency') {
    const roblox      = interaction.fields.getTextInputValue('roblox').trim();
    const posicao     = interaction.fields.getTextInputValue('posicao').trim();
    const experiencia = interaction.fields.getTextInputValue('experiencia').trim();
    const sobreMim    = interaction.fields.getTextInputValue('sobremim').trim();

    await interaction.deferReply({ flags: 64 });

    let tier      = 'N/A';
    let overall   = 'N/A';
    let avatarUrl = null;

    try {
      const dados = await buscarJogadorNaPlanilha(roblox);
      if (dados) {
        tier    = dados.tier || 'N/A';
        overall = dados.overall || 'N/A';
      }
    } catch (err) {
      console.error('❌ Erro ao consultar Google Sheets:', err);
      // Continua mesmo com erro, usando N/A
    }

    avatarUrl = await buscarAvatarRoblox(roblox);

    const tierEmoji = { S: '🟡', A: '🟠', B: '🟢', C: '🔵', D: '⚪', E: '🔴', F: '⚫' };
    const emoji = tierEmoji[tier] || '⚪';

   const embed = new EmbedBuilder()
  .setColor(CONFIG.EMBED_COLOR)
  .setAuthor({
    name: '🟢 Jogador Disponível',
    iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
  })
  .setThumbnail(avatarUrl)
  .setDescription(`👤 **Jogador**\n**Discord:** ${interaction.user}\n**Roblox:** \`${roblox}\``)
  .addFields(
    { name: '⚙️ Posição', value: posicao || 'Qualquer Posição', inline: false },
    { name: '📊 Estatísticas', value: `Tier: ${tier === 'N/A' ? '⚪ **N/A**' : `${emoji} **${tier}**`}\nOverall: **${overall}**`, inline: true },
    ...(experiencia ? [{ name: '📋 Experiência', value: experiencia, inline: false }] : []),
    ...(sobreMim    ? [{ name: '📝 Sobre Mim',   value: sobreMim,    inline: false }] : []),
  )
  .setFooter({ text: `ID: ${interaction.user.id}` })
  .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`btn_remove_${interaction.user.id}`)
        .setLabel('❌ Remover Anúncio')
        .setStyle(ButtonStyle.Danger),
    );

    try {
      const channel = await client.channels.fetch(CONFIG.CHANNEL_ID);
      const msg = await channel.send({ embeds: [embed], components: [row] });
      freeAgents.set(interaction.user.id, { messageId: msg.id, channelId: msg.channelId });
      await interaction.editReply({
        content: `✅ Anúncio publicado em <#${CONFIG.CHANNEL_ID}>!\n📊 Tier: **${tier}** | Overall: **${overall}**`,
      });
    } catch (err) {
      console.error('Erro ao enviar embed:', err);
      await interaction.editReply({
        content: '❌ Erro ao publicar o anúncio. Verifique as permissões do bot no canal.',
      });
    }
  }

  // ── BOTÃO ACEITAR CONTRATO (abre modal) ──────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('contract_accept_')) {
    const parts = interaction.customId.split('_');
    const allowedUserId = parts[2];
    const guildId = parts[3];

    if (interaction.user.id !== allowedUserId) {
      return interaction.reply({
        content: '⛔ Apenas o jogador mencionado na proposta pode aceitar.',
        flags: 64,
      });
    }

    const contractData = pendingContracts.get(interaction.message.id);
    if (!contractData) {
      return interaction.reply({
        content: '⚠️ Esta proposta já foi processada ou expirou.',
        flags: 64,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId(`modal_accept_contract_${interaction.message.id}`)
      .setTitle('✅ Aceitar Contratação');

    const robloxInput = new TextInputBuilder()
      .setCustomId('roblox')
      .setLabel('Coloque seu nick do Roblox')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('ex: erizin_kk')
      .setRequired(true)
      .setMaxLength(50);

    modal.addComponents(
      new ActionRowBuilder().addComponents(robloxInput),
    );

    await interaction.showModal(modal);
  }

  // ── MODAL: aceitar contrato ──────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_accept_contract_')) {
    const messageId = interaction.customId.replace('modal_accept_contract_', '');
    const roblox = interaction.fields.getTextInputValue('roblox').trim();

    const contractData = pendingContracts.get(messageId);
    if (!contractData) {
      return interaction.reply({
        content: '⚠️ Esta proposta já foi processada ou expirou.',
        flags: 64,
      });
    }

    await interaction.deferReply({ flags: 64 });

    let tier      = 'N/A';
    let overall   = 'N/A';
    let wage      = null;
    let avatarUrl = null;

    try {
      const dados = await buscarJogadorNaPlanilha(roblox);
      if (dados) {
        tier    = dados.tier || 'N/A';
        overall = dados.overall || 'N/A';
        wage    = dados.wage;
      }
    } catch (err) {
      console.error('❌ Erro ao consultar Google Sheets:', err);
      // Continua mesmo com erro, usando N/A
    }

    avatarUrl = await buscarAvatarRoblox(roblox);

    const tierEmoji = { S: '🟡', A: '🟠', B: '🟢', C: '🔵', D: '⚪', E: '🔴', F: '⚫' };
    const emoji = tierEmoji[tier] || '⚪';
    const salario = formatarLibras(wage);

    // Atualiza a mensagem na DM
    const acceptedEmbedDM = new EmbedBuilder()
      .setColor(0x57F287)
      .setAuthor({
        name: '🤝 Contratação Confirmada!',
      })
      .setThumbnail(avatarUrl)
      .setDescription(`**Roblox:** \`${roblox}\`\n**Time:** ${contractData.teamRole}`)
      .addFields(
        { name: '📊 Dados', value: `Tier: ${tier === 'N/A' ? '⚪ **N/A**' : `${emoji} **${tier}**`}\nOVR: **${overall}**\nWage: **${salario}**`, inline: false },
      )
      .setFooter({ text: `✅ Você aceitou a proposta!` })
      .setTimestamp();

    try {
      await interaction.message.edit({
        content: null,
        embeds: [acceptedEmbedDM],
        components: [],
      });
    } catch (err) {
      console.error('Erro ao editar DM:', err);
    }

    // Envia o anúncio no canal de contratações aceitas
    const guild = await client.guilds.fetch(contractData.guildId);
    const manager = await client.users.fetch(contractData.managerId);
    const teamRole = await guild.roles.fetch(contractData.teamRoleId);

    const acceptedEmbedChannel = new EmbedBuilder()
  .setColor(0x57F287)
  .setAuthor({
    name: '📥 Contratação',
    iconURL: guild.iconURL({ dynamic: true }),
  })
  .setThumbnail(avatarUrl)
  .setDescription(`♦️ **Jogador**\n**Discord:** ${interaction.user}\n**Roblox:** \`${roblox}\``)
  .addFields(
    { name: '🏆 Time', value: `${teamRole}`, inline: false },
    { name: '📋 Dados', value: `Tier: ${tier === 'N/A' ? '⚪ **N/A**' : `${emoji} **${tier}**`}\nOVR: **${overall}**\nSalário: **${salario}**`, inline: false },
  )
  .setFooter({ text: `✅ Contratado por ${manager.tag}` })
  .setTimestamp();

    try {
      const channel = await client.channels.fetch(CONFIG.CONTRACT_ACCEPTED_CHANNEL_ID);
      await channel.send({ embeds: [acceptedEmbedChannel] });
    } catch (err) {
      console.error('Erro ao enviar no canal de contratos aceitos:', err);
    }

    pendingContracts.delete(messageId);

    // Remove o anúncio de free agent do jogador se existir
    const faEntry = freeAgents.get(contractData.targetUserId);
    if (faEntry) {
      try {
        const faChannel = await client.channels.fetch(faEntry.channelId);
        const faMsg = await faChannel.messages.fetch(faEntry.messageId);
        await faMsg.delete();
      } catch (_) {}
      freeAgents.delete(contractData.targetUserId);
    }

    return interaction.editReply({
      content: '✅ Você aceitou a proposta! Contratação confirmada!',
    });
  }

  // ── BOTÃO RECUSAR CONTRATO ───────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('contract_decline_')) {
    const parts = interaction.customId.split('_');
    const allowedUserId = parts[2];

    if (interaction.user.id !== allowedUserId) {
      return interaction.reply({
        content: '⛔ Apenas o jogador mencionado na proposta pode recusar.',
        flags: 64,
      });
    }

    const contractData = pendingContracts.get(interaction.message.id);
    if (!contractData) {
      return interaction.reply({
        content: '⚠️ Esta proposta já foi processada ou expirou.',
        flags: 64,
      });
    }

    const declinedEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setAuthor({
        name: '❌ Proposta Recusada',
      })
      .setDescription(`**Time:** ${contractData.teamRole}`)
      .setFooter({ text: `❌ Você recusou esta proposta.` })
      .setTimestamp();

    await interaction.message.edit({
      content: null,
      embeds: [declinedEmbed],
      components: [],
    });

    pendingContracts.delete(interaction.message.id);

    // Notifica o técnico que a proposta foi recusada
    try {
      const manager = await client.users.fetch(contractData.managerId);
      await manager.send({
        content: `❌ **Proposta recusada!**\n${interaction.user} recusou a proposta de contratação para o time **${contractData.teamRole}**.`,
      });
    } catch (_) {}

    return interaction.reply({
      content: '❌ Você recusou a proposta de contratação.',
      flags: 64,
    });
  }

  // ── BOTÃO REMOVER FREE AGENT ─────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('btn_remove_')) {
    const ownerId = interaction.customId.replace('btn_remove_', '');
    const isOwner = interaction.user.id === ownerId;
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageMessages);

    if (!isOwner && !isAdmin) {
      return interaction.reply({
        content: '⛔ Apenas o dono do anúncio ou um moderador pode removê-lo.',
        flags: 64,
      });
    }

    try { await interaction.message.delete(); } catch (_) {}
    freeAgents.delete(ownerId);
    return interaction.reply({
      content: '✅ Anúncio removido com sucesso!',
      flags: 64,
    });
  }
});

client.login(CONFIG.TOKEN);