const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, Events, REST, Routes, SlashCommandBuilder, PermissionFlagsBits
} = require('discord.js');

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const STATE_FILE = path.join(__dirname, 'bot_state.json');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ]
});

// ─────────────────────────────────────────────
//  CONFIGURATION  (edit these to match your server)
// ─────────────────────────────────────────────
const CONFIG = {
  SHOP_CHANNEL:     'shop',         // channel where the shop embed lives
  RECEIPTS_CHANNEL: 'receipts',     // admin-only channel for incoming orders
  ORDERS_CHANNEL:   'orders',       // channel where buyers send receipt screenshots
  VOUCH_CHANNEL:    'vouches',      // channel where vouches are posted
  ADMIN_ROLE:       'Admin',        // role name that can confirm/cancel
  SHOP_PING:        '@here',     // mention to send before the shop embed (use @stock or @here if desired)
};

// ─────────────────────────────────────────────
//  FRUIT INVENTORY  (edit prices / stock freely)
// ─────────────────────────────────────────────realtime shop stock update when order confirmed, and make it replaces the last /posthop instead of massaging again in channel
const inventory = {
  kitsune:   { price: 145, stock: 1 },
  gas:       { price: 30,  stock: 2 },
  yeti:      { price: 50,  stock: 1 },
  tiger:     { price: 55,  stock: 1 },
  buddha:    { price: 10,  stock: 3 },
  portal:    { price: 10,  stock: 3 },
  dragon:    { price: 450,   stock: 0 },
  trex:      { price: 20,  stock: 1 },
  mammoth:   { price: 20,  stock: 3 },
  venom:     { price: 45,  stock: 2 },
  lightning: { price: 30,  stock: 1 },
  dough:     { price: 20,  stock: 3 },
};

// In-memory order store. Replace with a JSON file or SQLite for persistence.
const orders = new Map();
let orderCounter = 1;

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      console.log('ℹ️ No state file found, starting fresh.');
      return;
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const s = JSON.parse(raw || '{}');
    
    // Load order counter
    if (s.orderCounter && Number.isInteger(s.orderCounter) && s.orderCounter > 0) {
      orderCounter = s.orderCounter;
    }
    
    // Load inventory stock
    if (s.inventory && typeof s.inventory === 'object') {
      for (const [fruit, data] of Object.entries(s.inventory)) {
        if (inventory[fruit] && typeof data.stock === 'number') {
          inventory[fruit].stock = data.stock;
        }
      }
      console.log('✅ Inventory stock loaded from file.');
    }
    
    // Load orders
    if (s.orders && Array.isArray(s.orders)) {
      for (const orderData of s.orders) {
        if (orderData.orderId) {
          orders.set(orderData.orderId, orderData);
        }
      }
      console.log(`✅ ${orders.size} orders loaded from file.`);
    }
  } catch (e) {
    console.warn('⚠️ Could not load state file:', e.message);
  }
}

function saveState() {
  try {
    // Convert orders Map to array for JSON serialization
    const ordersArray = Array.from(orders.values());
    
    const s = { 
      orderCounter,
      inventory,
      orders: ordersArray,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch (e) {
    console.warn('⚠️ Could not save state file:', e.message);
  }
}

// Store shop message ID for updating
let lastShopMessageId = null;
let lastShopChannelId = null;
// Track last ping message per guild so we can remove it on next update
const lastShopPingMessageId = new Map();
// Load persisted state (order counter)
loadState();

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function isAdmin(member) {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.roles.cache.some(r => r.name === CONFIG.ADMIN_ROLE)
  );
}

function getAvailableStock(item) {
  return Math.max(0, item.stock - (item.reserved || 0));
}

function resolveShopPing(interaction) {
  const ping = String(CONFIG.SHOP_PING || '').trim();
  if (!ping || !interaction.guild) return undefined;

  if (ping === '@everyone' || ping === '@here') return ping;
  if (/^<@&\d+>$/.test(ping)) return ping;
  if (/^\d+$/.test(ping)) return `<@&${ping}>`;

  if (ping.startsWith('@')) {
    const roleName = ping.slice(1).trim().toLowerCase();
    const role = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === roleName);
    if (role) return `<@&${role.id}>`;
  }

  return ping;
}

function resolveShopPingForGuild(guild) {
  const ping = String(CONFIG.SHOP_PING || '').trim();
  if (!ping || !guild) return undefined;

  if (ping === '@everyone' || ping === '@here') return ping;
  if (/^<@&\d+>$/.test(ping)) return ping;
  if (/^\d+$/.test(ping)) return `<@&${ping}>`;

  if (ping.startsWith('@')) {
    const roleName = ping.slice(1).trim().toLowerCase();
    const role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName);
    if (role) return `<@&${role.id}>`;
  }

  return ping;
}

function buildShopEmbed() {
  const available = Object.entries(inventory)
    .map(([name, v]) => {
      const padding = ' '.repeat(Math.max(0, 12 - name.length));
      return `${name}${padding} - ₱${v.price} [${getAvailableStock(v)}]`;
    })
    .join('\n');

  return new EmbedBuilder()
    .setTitle('BYFRON BLOXFRUIT SHOP')
    .setDescription(
      'Pick a fruit below and click **Order Now** to start your order.\n\n' +
      '**Payment:** GCash and PayPal only\n' +
      '**Support:** DM @1mjustkael_ for any questions or issues with your order.'
    )
    .setColor(0xFFD700)
    .addFields(
      { 
        name: 'STOCK LIST', 
        value: '```\n' + available + '\n```', 
        inline: false 
      },
    )
    .setFooter({ text: 'byfron services • bloxfruit shop • Last updated' })
    .setTimestamp();
}

function buildFruitMenu() {
  const options = Object.entries(inventory)
    .filter(([, v]) => getAvailableStock(v) > 0)
    .map(([name, v]) => ({
      label: `${name}  —  ₱${v.price}`,
      description: `${getAvailableStock(v)} in stock`,
      value: name,
    }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_fruit')
      .setPlaceholder('Choose a fruit…')
      .setMinValues(1)
      .setMaxValues(Math.min(5, options.length))
      .addOptions(options)
  );
}

// Update the shop embed in the channel (edit existing message instead of posting new ones)
async function updateShopDisplay(guild, sendPing = true) {
  try {
    if (!lastShopChannelId || !lastShopMessageId) return; // No shop message to update

    const channel = guild.channels.cache.get(lastShopChannelId) || await guild.channels.fetch(lastShopChannelId);
    if (!channel || !channel.isTextBased()) return;

    const message = await channel.messages.fetch(lastShopMessageId);
    if (!message) return;

    const shopEmbed = buildShopEmbed();
    const shopComponents = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('start_order')
          .setLabel('Order Now')
          .setStyle(ButtonStyle.Success)
      )
    ];

    await message.edit({
      embeds: [shopEmbed],
      components: shopComponents,
    });
    
    if (sendPing && CONFIG.SHOP_PING) {
      try {
        const resolved = resolveShopPingForGuild(guild);
        if (resolved) {
          // delete previous ping message if present
          const prevId = lastShopPingMessageId.get(guild.id);
          if (prevId) {
            try {
              const prevMsg = await channel.messages.fetch(prevId).catch(() => null);
              if (prevMsg) await prevMsg.delete().catch(() => null);
            } catch (e) { /* ignore deletion errors */ }
          }

          const pingMsg = await channel.send({
            content: `${resolved} Shop stock updated!`,
            allowedMentions: { parse: ['roles', 'everyone'] },
          });
          // remember this ping so it can be removed on next update
          lastShopPingMessageId.set(guild.id, pingMsg.id);
        }
      } catch (e) {
        console.warn('⚠️ Could not send shop update ping:', e.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Could not update shop display:', err.message);
  }
}

// ─────────────────────────────────────────────
//  SLASH COMMANDS
// ─────────────────────────────────────────────
const slashCommands = [
  new SlashCommandBuilder()
    .setName('postshop')
    .setDescription('Post / refresh the shop embed (Admin only)')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Update fruit stock (Admin only)')
    .addStringOption(o =>
      o.setName('fruit').setDescription('Fruit name').setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('amount').setDescription('New stock amount').setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('addfruit')
    .setDescription('Add a new fruit to the shop (Admin only)')
    .addStringOption(o =>
      o.setName('name').setDescription('Fruit name').setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('price').setDescription('Fruit price in pesos').setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('stock').setDescription('Initial stock amount').setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('editprice')
    .setDescription('Edit fruit price (Admin only)')
    .addStringOption(o =>
      o.setName('fruit').setDescription('Fruit name').setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('price').setDescription('New price in pesos').setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('removefruit')
    .setDescription('Remove a fruit from the shop (Admin only)')
    .addStringOption(o =>
      o.setName('fruit').setDescription('Fruit name').setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('orders')
    .setDescription('List all pending orders (Admin only)')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('closeticket')
    .setDescription('Close an order ticket channel (Admin or buyer)')
    .addStringOption(o =>
      o.setName('orderid').setDescription('Order ID to close').setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('bulkadd')
    .setDescription('Add stock to multiple fruits at once (Admin only)')
    .addStringOption(o =>
      o.setName('data').setDescription('Format: fruit1:amount1 fruit2:amount2 (space-separated)').setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('bulkorder')
    .setDescription('Order multiple fruits at once with quantities')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('bulkstock')
    .setDescription('Update stock for multiple fruits at once (Admin only)')
    .toJSON(),
];

// ─────────────────────────────────────────────
//  BOT READY
// ─────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`✅  Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('✅  Slash commands registered globally.');
  } catch (err) {
    console.error('❌  Failed to register commands:', err);
  }
});

// ─────────────────────────────────────────────
//  INTERACTION HANDLER
// ─────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // ── /postshop ──────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'postshop') {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const shopMessage = await interaction.channel.send({
      embeds: [buildShopEmbed()],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('start_order')
            .setLabel('Order Now')
            .setStyle(ButtonStyle.Success)
        )
      ],
    });

    // Store the message ID for future updates
    lastShopMessageId = shopMessage.id;
    lastShopChannelId = interaction.channel.id;

    return interaction.reply({ content: '✅ Shop posted!', ephemeral: true });
  }

  // ── /stock ─────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'stock') {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const fruit  = interaction.options.getString('fruit').toLowerCase();
    const amount = interaction.options.getInteger('amount');

    if (!inventory[fruit])
      return interaction.reply({ content: `❌ Unknown fruit: \`${fruit}\``, ephemeral: true });

    inventory[fruit].stock = amount;
    inventory[fruit].reserved = Math.min(inventory[fruit].reserved || 0, amount);
    saveState();  // SAVE TO FILE

    // Update the shop display in real-time (ping because stock changed via delivery)
    await updateShopDisplay(interaction.guild, true);

    return interaction.reply({
      content: `✅ **${fruit}** stock updated to **${amount}**. (saved to file)`,
      ephemeral: true,
    });
  }

  // ── /bulkstock ──────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'bulkstock') {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const allFruits = Object.entries(inventory);
    
    if (allFruits.length === 0) {
      return interaction.reply({
        content: 'No fruits in inventory!',
        ephemeral: true,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId(`bulkstock_modal:${interaction.user.id}:${Date.now()}`)
      .setTitle('Update Fruit Stock');

    // Add text input for each fruit (up to 5 for modal limit)
    const fruitsToShow = allFruits.slice(0, 5);
    
    for (const [fruit, data] of fruitsToShow) {
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(`stock_${fruit}`)
            .setLabel(`${fruit} (current: ${data.stock})`)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(String(data.stock))
            .setRequired(false)
            .setMaxLength(3)
        )
      );
    }

    // If more than 5 fruits, add a note
    if (allFruits.length > 5) {
      return interaction.reply({
        content: `⚠️ You have ${allFruits.length} fruits total. Form shows first 5. For others, use \`/stock\` command.`,
        ephemeral: true,
      });
    }

    return interaction.showModal(modal);
  }

  // ── /addfruit ──────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'addfruit') {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const name  = interaction.options.getString('name').toLowerCase();
    const price = interaction.options.getInteger('price');
    const stock = interaction.options.getInteger('stock');

    if (inventory[name])
      return interaction.reply({ content: `❌ **${name}** already exists in inventory!`, ephemeral: true });

    inventory[name] = { price, stock };
    saveState();  // SAVE TO FILE

    // Update the shop display in real-time
    await updateShopDisplay(interaction.guild);

    return interaction.reply({
      content: `✅ **${name}** added to shop! Price: ₱${price} | Stock: ${stock} (saved to file)`,
      ephemeral: true,
    });
  }

  // ── /editprice ─────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'editprice') {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const fruit = interaction.options.getString('fruit').toLowerCase();
    const price = interaction.options.getInteger('price');

    if (!inventory[fruit])
      return interaction.reply({ content: `❌ Unknown fruit: \`${fruit}\``, ephemeral: true });

    const oldPrice = inventory[fruit].price;
    inventory[fruit].price = price;
    saveState();  // SAVE TO FILE

    // Update the shop display in real-time
    await updateShopDisplay(interaction.guild);

    return interaction.reply({
      content: `✅ **${fruit}** price updated: ₱${oldPrice} → ₱${price} (saved to file)`,
      ephemeral: true,
    });
  }

  // ── /removefruit ───────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'removefruit') {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const fruit = interaction.options.getString('fruit').toLowerCase();

    if (!inventory[fruit])
      return interaction.reply({ content: `❌ Unknown fruit: \`${fruit}\``, ephemeral: true });

    delete inventory[fruit];
    saveState();  // SAVE TO FILE

    // Update the shop display in real-time
    await updateShopDisplay(interaction.guild);

    return interaction.reply({
      content: `✅ **${fruit}** removed from shop. (saved to file)`,
      ephemeral: true,
    });
  }

  // ── /bulkadd ────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'bulkadd') {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const data = interaction.options.getString('data').trim();
    const parts = data.split(/\s+/);  // Split by whitespace
    
    const updates = [];
    const errors = [];

    for (const part of parts) {
      const [fruit, amountStr] = part.split(':');
      const fruitLower = fruit.toLowerCase();
      const amount = parseInt(amountStr);

      if (!fruit || !amountStr || isNaN(amount)) {
        errors.push(`Invalid format: \`${part}\` (use fruit:amount)`);
        continue;
      }

      if (!inventory[fruitLower]) {
        errors.push(`Unknown fruit: \`${fruitLower}\``);
        continue;
      }

      if (amount < 0) {
        errors.push(`Negative amount not allowed: \`${fruitLower}\``);
        continue;
      }

      inventory[fruitLower].stock += amount;
      updates.push(`${fruitLower} +${amount} → ${inventory[fruitLower].stock}`);
    }

    saveState();  // SAVE TO FILE
    await updateShopDisplay(interaction.guild);

    let response = '';
    if (updates.length > 0) {
      response += '✅ Updated:\n' + updates.map(u => `  • ${u}`).join('\n');
    }
    if (errors.length > 0) {
      response += (updates.length > 0 ? '\n\n' : '') + '❌ Errors:\n' + errors.map(e => `  • ${e}`).join('\n');
    }

    return interaction.reply({ content: response || 'No changes made.', ephemeral: true });
  }
  if (interaction.isChatInputCommand() && interaction.commandName === 'orders') {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const pending = [...orders.values()].filter(o => o.status === 'pending');
    if (pending.length === 0)
      return interaction.reply({ content: 'No pending orders.', ephemeral: true });

    const list = pending
      .map(o => `\`${o.orderId}\` — ${o.fruit || o.items?.map(i => i.fruit).join(', ')} (${o.username})`)
      .join('\n');

    return interaction.reply({ content: `**Pending Orders:**\n${list}`, ephemeral: true });
  }

  // ── /bulkorder ──────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'bulkorder') {
    const available = Object.entries(inventory).filter(([, v]) => getAvailableStock(v) > 0);
    
    if (available.length === 0) {
      return interaction.reply({
        content: 'Sorry, no fruits are currently in stock!',
        ephemeral: true,
      });
    }

    // Build list of available fruits for the modal description
    const fruitList = available.map(([name, v]) => `${name} (${getAvailableStock(v)} available)`).join(', ');

    const modal = new ModalBuilder()
      .setCustomId(`bulkorder_modal:${interaction.user.id}:${Date.now()}`)
      .setTitle('Order Multiple Fruits');

    // Add text input for each available fruit (up to 5 max for modal limit)
    const fieldsToShow = available.slice(0, 5);
    
    for (const [fruit, data] of fieldsToShow) {
      const available_qty = getAvailableStock(data);
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(`qty_${fruit}`)
            .setLabel(`${fruit} (${available_qty} available)`)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('0')
            .setRequired(false)
            .setMaxLength(3)
        )
      );
    }

    // If more than 5 fruits, add a note
    if (available.length > 5) {
      return interaction.reply({
        content: `⚠️ You have more than 5 fruits in stock. Please use the form for the first 5 or use separate orders:\n\n${fruitList}`,
        ephemeral: true,
      });
    }

    return interaction.showModal(modal);
  }

  // ── /closeticket ───────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'closeticket') {
    const orderId = interaction.options.getString('orderid');
    const order = orders.get(orderId);
    if (!order) return interaction.reply({ content: `❌ Order not found: ${orderId}`, ephemeral: true });
    if (!order.ticketChannelId) return interaction.reply({ content: `❌ Order ${orderId} does not have an open ticket.`, ephemeral: true });

    const isOwner = interaction.user.id === order.userId;
    if (!isOwner && !isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Only the buyer or staff can close this ticket.', ephemeral: true });

    const guild = client.guilds.cache.get(order.guildId) || await client.guilds.fetch(order.guildId);
    if (!guild) return interaction.reply({ content: '❌ Could not resolve the guild for this order.', ephemeral: true });

    const ticketChannel = await guild.channels.fetch(order.ticketChannelId).catch(() => null);
    if (!ticketChannel) return interaction.reply({ content: '❌ Ticket channel not found or already deleted.', ephemeral: true });

    try {
      await ticketChannel.delete(`Ticket closed by ${interaction.user.tag}`);
      order.ticketChannelId = null;
      if (order.status === 'accepted') order.status = 'closed';
      saveState();  // SAVE TO FILE
      return interaction.reply({ content: `✅ Ticket for ${orderId} has been closed.`, ephemeral: true });
    } catch (err) {
      console.error('❌ Could not delete ticket channel:', err);
      return interaction.reply({ content: '❌ Could not delete the ticket channel. Check bot permissions.', ephemeral: true });
    }
  }

  // ── Button: "Order Now" ────────────────────
  if (interaction.isButton() && interaction.customId === 'start_order') {
    const hasStock = Object.values(inventory).some(v => getAvailableStock(v) > 0);
    if (!hasStock)
      return interaction.reply({ content: 'All fruits are currently out of stock. Check back later!', ephemeral: true });

    return interaction.reply({
      content: '**Step 1 of 2 —** Select the fruit you want:',
      components: [buildFruitMenu()],
      ephemeral: true,
    });
  }

  // ── Select Menu: fruit chosen (supports multi-select) ──────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_fruit') {
    const selections = interaction.values; // array of fruit keys
    // single selection: keep the existing friendly flow
    if (selections.length === 1) {
      const fruit = selections[0];
      const f     = inventory[fruit];

      return interaction.reply({
        content:
          `You selected  **${fruit}**  — ₱${f.price}\n` +
          `*(${getAvailableStock(f)} in stock)*\n\n` +
          `**Step 2 of 2 —** Click below to fill in your order details.`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`fill_order:${fruit}`)
              .setLabel('Fill Order Form')
              .setStyle(ButtonStyle.Primary)
          )
        ],
        ephemeral: true,
      });
    }

    // multiple selection: open a modal to collect quantities for each selected fruit
    const maxSelect = selections.length;
    const modal = new ModalBuilder()
      .setCustomId(`order_modal_multi:${selections.join(',')}`)
      .setTitle(`Bulk Order (${selections.length} items)`);

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('items')
          .setLabel('Items and quantities')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Enter items and quantities, e.g. dragon:1, yeti:1 or dragon 1\nyeti 1')
          .setRequired(true)
          .setMaxLength(400)
      )
    );

    return interaction.showModal(modal);
  }

  // ── Button: open order modal ───────────────
  if (interaction.isButton() && interaction.customId.startsWith('fill_order:')) {
    const fruit = interaction.customId.split(':')[1];
    const f     = inventory[fruit];

    const modal = new ModalBuilder()
      .setCustomId(`order_modal:${fruit}`)
      .setTitle(`Order: ${fruit}  (₱${f.price} each)`);

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('game_username')
          .setLabel('Roblox / In-Game Username')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. CoolPlayer123')
          .setRequired(true)
          .setMaxLength(50)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('quantity')
          .setLabel('Quantity (how many?)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 1')
          .setRequired(true)
          .setMaxLength(2)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('payment_method')
          .setLabel('Payment Method')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('gcash  or  paypal')
          .setRequired(true)
          .setMaxLength(10)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('account_info')
          .setLabel('GCash Number / PayPal Email')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 09XXXXXXXXX  or  you@paypal.com')
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reference')
          .setLabel('Transaction / Reference Number')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Pay first, then paste the ref # here')
          .setRequired(true)
          .setMaxLength(60)
      ),
    );

    return interaction.showModal(modal);
  }

  // ── Modal Submit: order form ───────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith('order_modal:')) {
    try {
      const fruit = interaction.customId.split(':')[1];
      const f     = inventory[fruit];

      const qty           = Math.max(1, parseInt(interaction.fields.getTextInputValue('quantity')) || 1);
      const paymentMethod = interaction.fields.getTextInputValue('payment_method').toLowerCase().trim();
      const accountInfo   = interaction.fields.getTextInputValue('account_info').trim();
      const reference     = interaction.fields.getTextInputValue('reference').trim();
      const gameUsername  = interaction.fields.getTextInputValue('game_username').trim();
      const availableStock = getAvailableStock(f);

      if (qty > availableStock) {
        return interaction.reply({
          content: `❌ Only **${availableStock}** ${fruit} left in stock. Please adjust your quantity.`,
          ephemeral: true,
        });
      }

      const total   = f.price * qty;
      const orderId = `ORD-${String(orderCounter++).padStart(4, '0')}`;

      orders.set(orderId, {
        orderId, userId: interaction.user.id, username: interaction.user.tag,
        guildId: interaction.guild.id,
        fruit, qty, total, paymentMethod, accountInfo, reference, gameUsername,
        status: 'pending', timestamp: new Date().toISOString(),
      });

      // persist updated orderCounter to disk so sequence survives restarts
      try { saveState(); } catch (e) { /* swallow */ }

      f.reserved = (f.reserved || 0) + qty;

      // Post to admin receipts channel
      const guild           = interaction.guild;
      // Fetch all channels in case cache is incomplete
      await guild.channels.fetch();
      const receiptsChannel = guild.channels.cache.find(
        c => c.name === CONFIG.RECEIPTS_CHANNEL && c.isTextBased()
      );
      const ordersChannel = guild.channels.cache.find(
        c => c.name === CONFIG.ORDERS_CHANNEL && c.isTextBased()
      );

      if (!receiptsChannel) {
        console.warn(`⚠️  Could not find channel "#${CONFIG.RECEIPTS_CHANNEL}". Create it or update CONFIG.RECEIPTS_CHANNEL in bot.js`);
      } else {
        const orderEmbed = new EmbedBuilder()
          .setTitle(`New Order — ${orderId}`)
          .setColor(0xFFA500)
          .addFields(
            { name: 'Customer',      value: `<@${interaction.user.id}>\n${interaction.user.tag}`, inline: true },
            { name: 'In-Game Name',  value: gameUsername,  inline: true },
            { name: 'Fruit',         value: `${fruit}`, inline: true },
            { name: 'Quantity',      value: `${qty}`,      inline: true },
            { name: 'Total Amount',  value: `₱${total}`,   inline: true },
            { name: 'Payment',       value: paymentMethod.toUpperCase(), inline: true },
            { name: 'Buyer Account', value: accountInfo,   inline: true },
            { name: 'Reference #',   value: `\`${reference}\``, inline: false },
          )
          .setTimestamp()
          .setFooter({ text: `Order ID: ${orderId}` });

        try {
          await receiptsChannel.send({
            content: `New order from <@${interaction.user.id}>. Accept the order to create a private ticket, then deliver and confirm it when ready.`,
            embeds: [orderEmbed],
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`accept_order:${orderId}`)
                  .setLabel('Accept Order')
                  .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                  .setCustomId(`confirm_order:${orderId}`)
                  .setLabel('Mark Delivered')
                  .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                  .setCustomId(`cancel_order:${orderId}`)
                  .setLabel('Cancel Order')
                  .setStyle(ButtonStyle.Danger),
              )
            ],
          });
        } catch (sendErr) {
          console.error(`❌ Failed to post to #${CONFIG.RECEIPTS_CHANNEL}:`, sendErr.message);
          console.error('   → Make sure the bot has Send Messages + View Channel permission in that channel.');
        }
      }

      // Update the shop display to show reserved stock changes and ping if configured
      await updateShopDisplay(interaction.guild, true);

      // Tell the buyer what to do next
      return interaction.reply({
        content:
          `✅  **Order placed!**\n\n` +
          `> Order ID: \`${orderId}\`\n` +
          `> **${fruit}** × ${qty}  =  **₱${total}**\n\n` +
          `Please send your **payment screenshot** to ${ordersChannel ? `<#${ordersChannel.id}>` : `#${CONFIG.ORDERS_CHANNEL}`} ` +
          `and include your Order ID \`${orderId}\` in the message.\n\n` +
          `You'll receive a **DM** once your order is confirmed. Thank you! `,
        ephemeral: true,
      });

    } catch (err) {
      console.error('❌ Error handling order modal:', err);
      // If we haven't replied yet, send an error message
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({
          content: '❌ Something went wrong saving your order. Please try again or DM @somin.',
          ephemeral: true,
        });
      }
    }
  }

  // ── Modal Submit: bulk order form ───────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith('order_modal_multi:')) {
    try {
      const selectionPart = interaction.customId.split(':')[1];
      const selections = selectionPart.split(',').map(s => s.trim());

      const raw = interaction.fields.getTextInputValue('items').trim();
      // split by newline or comma
      const tokens = raw.split(/[,\n]+/).map(t => t.trim()).filter(Boolean);
      const quantities = {};
      for (const tok of tokens) {
        let [name, qty] = tok.split(':').map(x => x && x.trim());
        if (!qty) {
          // try whitespace separator
          const parts = tok.split(/\s+/);
          name = parts[0];
          qty = parts[1];
        }
        if (!name || !qty) continue;
        const key = name.toLowerCase();
        const n = parseInt(qty, 10) || 0;
        if (n > 0) quantities[key] = (quantities[key] || 0) + n;
      }

      // Validate all selections are present in quantities
      for (const sel of selections) {
        if (!quantities[sel]) {
          return interaction.reply({ content: `❌ Missing quantity for **${sel}**. Follow the format: fruit:quantity`, ephemeral: true });
        }
      }

      // Validate stock and compute total
      let total = 0;
      const items = [];
      for (const sel of selections) {
        const f = inventory[sel];
        if (!f) return interaction.reply({ content: `❌ Unknown fruit: ${sel}`, ephemeral: true });
        const qty = quantities[sel] || 0;
        const available = getAvailableStock(f);
        if (qty > available) return interaction.reply({ content: `❌ Only **${available}** ${sel} left in stock.`, ephemeral: true });
        total += f.price * qty;
        items.push({ fruit: sel, qty, price: f.price });
      }

      const orderId = `ORD-${String(orderCounter++).padStart(4, '0')}`;
      orders.set(orderId, {
        orderId, userId: interaction.user.id, username: interaction.user.tag,
        guildId: interaction.guild.id,
        items, total,
        status: 'pending', timestamp: new Date().toISOString(),
      });
      try { saveState(); } catch (e) { }

      // reserve stock for each item
      for (const it of items) {
        const obj = inventory[it.fruit];
        obj.reserved = (obj.reserved || 0) + it.qty;
      }

      // Post to receipts channel similar to single order but list items
      const guild = interaction.guild;
      await guild.channels.fetch();
      const receiptsChannel = guild.channels.cache.find(c => c.name === CONFIG.RECEIPTS_CHANNEL && c.isTextBased());
      const ordersChannel = guild.channels.cache.find(c => c.name === CONFIG.ORDERS_CHANNEL && c.isTextBased());

      if (receiptsChannel) {
        const fields = [
          { name: 'Customer', value: `<@${interaction.user.id}>\n${interaction.user.tag}`, inline: true },
          { name: 'Payment', value: 'N/A', inline: true },
        ];
        // add item lines in description
        const itemLines = items.map(it => `${it.fruit} × ${it.qty}  —  ₱${it.price * it.qty}`).join('\n');

        const orderEmbed = new EmbedBuilder()
          .setTitle(`New Bulk Order — ${orderId}`)
          .setColor(0xFFA500)
          .setDescription(itemLines)
          .addFields(
            ...fields,
            { name: 'Total Amount', value: `₱${total}`, inline: true },
          )
          .setTimestamp()
          .setFooter({ text: `Order ID: ${orderId}` });

        try {
          await receiptsChannel.send({
            content: `New order from <@${interaction.user.id}>. Accept the order to create a private ticket, then deliver and confirm it when ready.`,
            embeds: [orderEmbed],
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`accept_order:${orderId}`).setLabel('Accept Order').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`confirm_order:${orderId}`).setLabel('Mark Delivered').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`cancel_order:${orderId}`).setLabel('Cancel Order').setStyle(ButtonStyle.Danger),
              )
            ],
          });
        } catch (sendErr) {
          console.error(`❌ Failed to post to #${CONFIG.RECEIPTS_CHANNEL}:`, sendErr.message);
        }
      }

      await updateShopDisplay(interaction.guild, true);

      return interaction.reply({ content: `✅ Order placed! Order ID: \`${orderId}\` — Total: ₱${total}`, ephemeral: true });

    } catch (err) {
      console.error('❌ Error handling bulk order modal:', err);
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({ content: '❌ Something went wrong saving your bulk order. Please try again.', ephemeral: true });
      }
    }
  }

  // ── Modal Submit: bulk order form ────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith('bulkorder_modal:')) {
    try {
      const items = [];
      let total = 0;

      // Collect quantities from modal inputs
      for (const [fruit, data] of Object.entries(inventory)) {
        try {
          const qtyStr = interaction.fields.getTextInputValue(`qty_${fruit}`).trim();
          if (!qtyStr || qtyStr === '0') continue;  // Skip if empty or 0

          const qty = parseInt(qtyStr);
          if (isNaN(qty) || qty <= 0) continue;

          const available = getAvailableStock(data);
          if (qty > available) {
            return interaction.reply({
              content: `❌ Only **${available}** ${fruit} left in stock. Adjust your quantity.`,
              ephemeral: true,
            });
          }

          items.push({ fruit, qty, price: data.price });
          total += data.price * qty;
        } catch {
          // Field doesn't exist for this fruit, skip
          continue;
        }
      }

      // Check if at least one item was selected
      if (items.length === 0) {
        return interaction.reply({
          content: '❌ Please enter at least one quantity greater than 0.',
          ephemeral: true,
        });
      }

      // Create order
      const orderId = `ORD-${String(orderCounter++).padStart(4, '0')}`;
      orders.set(orderId, {
        orderId,
        userId: interaction.user.id,
        username: interaction.user.tag,
        guildId: interaction.guild.id,
        items,
        total,
        status: 'pending',
        timestamp: new Date().toISOString(),
      });
      saveState();

      // Reserve stock
      for (const item of items) {
        inventory[item.fruit].reserved = (inventory[item.fruit].reserved || 0) + item.qty;
      }

      // Post to receipts channel
      const guild = interaction.guild;
      await guild.channels.fetch();
      const receiptsChannel = guild.channels.cache.find(c => c.name === CONFIG.RECEIPTS_CHANNEL && c.isTextBased());

      if (receiptsChannel) {
        const itemLines = items.map(it => `**${it.fruit}** × ${it.qty}  —  ₱${it.price * it.qty}`).join('\n');
        
        const orderEmbed = new EmbedBuilder()
          .setTitle(`New Bulk Order — ${orderId}`)
          .setColor(0xFFA500)
          .setDescription(`**Items:**\n${itemLines}`)
          .addFields(
            { name: 'Customer', value: `<@${interaction.user.id}>\n${interaction.user.tag}`, inline: true },
            { name: 'Total Amount', value: `₱${total}`, inline: true },
          )
          .setTimestamp()
          .setFooter({ text: `Order ID: ${orderId}` });

        try {
          await receiptsChannel.send({
            content: `New bulk order from <@${interaction.user.id}>. Accept the order to create a ticket, then deliver and confirm.`,
            embeds: [orderEmbed],
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`accept_order:${orderId}`).setLabel('Accept Order').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`confirm_order:${orderId}`).setLabel('Mark Delivered').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`cancel_order:${orderId}`).setLabel('Cancel Order').setStyle(ButtonStyle.Danger),
              )
            ],
          });
        } catch (sendErr) {
          console.error(`Failed to post to #${CONFIG.RECEIPTS_CHANNEL}:`, sendErr.message);
        }
      }

      await updateShopDisplay(interaction.guild, true);

      // Show summary to buyer
      const summary = items.map(it => `${it.fruit} × ${it.qty}`).join(', ');
      return interaction.reply({
        content: `✅ **Bulk order placed!**\n\n` +
                 `Order ID: \`${orderId}\`\n` +
                 `Items: ${summary}\n` +
                 `Total: **₱${total}**\n\n` +
                 `Admin will review and create a ticket for you shortly!`,
        ephemeral: true,
      });

    } catch (err) {
      console.error('Error handling bulkorder modal:', err);
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({
          content: '❌ Something went wrong. Please try again.',
          ephemeral: true,
        });
      }
    }
  }

  // ── Modal Submit: bulk stock update ──────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith('bulkstock_modal:')) {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    try {
      const updates = [];
      const errors = [];

      // Collect stock updates from modal inputs
      for (const [fruit, data] of Object.entries(inventory)) {
        try {
          const stockStr = interaction.fields.getTextInputValue(`stock_${fruit}`).trim();
          if (!stockStr) continue;  // Skip if empty

          const newStock = parseInt(stockStr);
          if (isNaN(newStock) || newStock < 0) {
            errors.push(`Invalid amount for ${fruit}: must be a positive number`);
            continue;
          }

          const oldStock = data.stock;
          inventory[fruit].stock = newStock;
          inventory[fruit].reserved = Math.min(inventory[fruit].reserved || 0, newStock);
          
          updates.push(`${fruit}: ${oldStock} → ${newStock}`);
        } catch {
          // Field doesn't exist for this fruit, skip
          continue;
        }
      }

      // Check if at least one fruit was updated
      if (updates.length === 0 && errors.length === 0) {
        return interaction.reply({
          content: '❌ Please update at least one fruit stock.',
          ephemeral: true,
        });
      }

      // Save changes
      saveState();
      await updateShopDisplay(interaction.guild, true);

      // Build response
      let response = '';
      if (updates.length > 0) {
        response += '✅ **Stock Updated:**\n' + updates.map(u => `  • ${u}`).join('\n');
      }
      if (errors.length > 0) {
        response += (updates.length > 0 ? '\n\n' : '') + '❌ **Errors:**\n' + errors.map(e => `  • ${e}`).join('\n');
      }

      return interaction.reply({
        content: response,
        ephemeral: true,
      });

    } catch (err) {
      console.error('Error handling bulkstock modal:', err);
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({
          content: '❌ Something went wrong. Please try again.',
          ephemeral: true,
        });
      }
    }
  }

  // ── Button: Admin accepts order and creates ticket ───────────
  if (interaction.isButton() && interaction.customId.startsWith('accept_order:')) {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const orderId = interaction.customId.split(':')[1];
    const order   = orders.get(orderId);

    if (!order) return interaction.reply({ content: '❌ Order not found.', ephemeral: true });
    if (order.status !== 'pending')
      return interaction.reply({ content: `⚠️ Order is already **${order.status}**.`, ephemeral: true });

    const guild = interaction.guild;
    const adminRole = guild.roles.cache.find(r => r.name === CONFIG.ADMIN_ROLE);
    const channelName = `ticket-${orderId.toLowerCase()}`;
    const permissionOverwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: order.userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];
    if (adminRole) {
      permissionOverwrites.push({ id: adminRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }

    let ticketChannel;
    try {
      ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        permissionOverwrites,
      });
    } catch (err) {
      console.error('❌ Failed to create ticket channel:', err);
      return interaction.reply({ content: '❌ Could not create ticket channel. Please check permissions.', ephemeral: true });
    }

    order.status = 'accepted';
    order.acceptedBy = interaction.user.tag;
    order.ticketChannelId = ticketChannel.id;

    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0x00B0F4)
      .setTitle(`ACCEPTED — ${orderId}`)
      .addFields({ name: 'Accepted By', value: interaction.user.tag, inline: true });

    await interaction.message.edit({
      embeds: [updatedEmbed],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`confirm_order:${orderId}`).setLabel('Mark Delivered').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`cancel_order:${orderId}`).setLabel('Cancel Order').setStyle(ButtonStyle.Danger),
        )
      ],
    });

    try {
      await ticketChannel.send({
        content: `Order **${orderId}** has been accepted by <@${interaction.user.id}>. <@${order.userId}> has been added to this private ticket channel.`,
        allowedMentions: { users: [interaction.user.id, order.userId] },
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`close_ticket:${orderId}`).setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
          )
        ]
      });
    } catch (err) {
      console.warn('⚠️ Could not send ticket welcome message:', err.message);
    }

    return interaction.reply({ content: `✅ Order accepted and ticket created: <#${ticketChannel.id}>`, ephemeral: true });
  }

  // ── Button: Close a ticket channel ───────────
  if (interaction.isButton() && interaction.customId.startsWith('close_ticket:')) {
    const orderId = interaction.customId.split(':')[1];
    const order = orders.get(orderId);
    if (!order) return interaction.reply({ content: '❌ Order not found.', ephemeral: true });

    const canClose = isAdmin(interaction.member) || interaction.user.id === order.userId;
    if (!canClose) return interaction.reply({ content: '❌ Only staff or the order owner can close this ticket.', ephemeral: true });
    if (!order.ticketChannelId) return interaction.reply({ content: '❌ No ticket channel is linked to this order.', ephemeral: true });

    const guild = client.guilds.cache.get(order.guildId) || await client.guilds.fetch(order.guildId);
    if (!guild) return interaction.reply({ content: '❌ Could not resolve the guild for this order.', ephemeral: true });

    const channel = await guild.channels.fetch(order.ticketChannelId).catch(() => null);
    if (!channel) return interaction.reply({ content: '❌ Ticket channel not found or already deleted.', ephemeral: true });

    try {
      await channel.delete(`Ticket closed by ${interaction.user.tag}`);
    } catch (err) {
      console.error('❌ Could not delete ticket channel:', err);
      return interaction.reply({ content: '❌ Could not delete the ticket channel. Check permissions.', ephemeral: true });
    }

    order.ticketChannelId = null;
    order.status = order.status === 'accepted' ? 'closed' : order.status;

    return interaction.reply({ content: `✅ Ticket closed.`, ephemeral: true });
  }

  // ── Button: Admin confirms order ───────────
  if (interaction.isButton() && interaction.customId.startsWith('confirm_order:')) {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const orderId = interaction.customId.split(':')[1];
    const order   = orders.get(orderId);

    if (!order)  return interaction.reply({ content: '❌ Order not found.', ephemeral: true });
    if (order.status === 'pending')
      return interaction.reply({ content: '⚠️ Please accept the order first before confirming delivery.', ephemeral: true });
    if (order.status !== 'accepted')
      return interaction.reply({ content: `⚠️ Order is already **${order.status}**.`, ephemeral: true });

    order.status      = 'confirmed';
    order.confirmedBy = interaction.user.tag;

    // Commit reserved stock for each item in multi-item orders
    if (Array.isArray(order.items)) {
      for (const it of order.items) {
        const item = inventory[it.fruit];
        if (!item) continue;
        item.stock = Math.max(0, item.stock - it.qty);
        item.reserved = Math.max(0, (item.reserved || 0) - it.qty);
      }
    } else if (order.fruit) {
      const item = inventory[order.fruit];
      if (item) {
        item.stock = Math.max(0, item.stock - order.qty);
        item.reserved = Math.max(0, (item.reserved || 0) - order.qty);
      }
    }

    saveState();  // SAVE TO FILE

    // Edit the receipts-channel embed to green
    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0x57F287)
      .setTitle(`CONFIRMED — ${orderId}`)
      .addFields({ name: 'Confirmed By', value: interaction.user.tag, inline: true });

    await interaction.message.edit({ embeds: [updatedEmbed], components: [] });

    // Update the shop display in real-time
    await updateShopDisplay(interaction.guild);

    // DM the buyer
    try {
      const buyerMember = await interaction.guild.members.fetch(order.userId);
      const deliverEmbed = new EmbedBuilder()
        .setTitle('Your order has been delivered!')
        .setColor(0x57F287)
        .setDescription(`Thank you for shopping at **byfron services**!`)
        .addFields({ name: 'Order ID', value: orderId, inline: true });

      if (Array.isArray(order.items)) {
        const desc = order.items.map(it => `${it.fruit} × ${it.qty}`).join('\n');
        deliverEmbed.addFields({ name: 'Items', value: desc, inline: false }, { name: 'Total', value: `₱${order.total}`, inline: true });
      } else {
        deliverEmbed.addFields({ name: 'Product', value: order.fruit || 'N/A', inline: true }, { name: 'In-Game Name', value: order.gameUsername || 'N/A', inline: true });
      }

      await buyerMember.send({
        embeds: [deliverEmbed],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`vouch_order:${orderId}`).setLabel('Leave a Vouch').setStyle(ButtonStyle.Success)
          )
        ]
      });
    } catch {
      console.warn(`Could not DM buyer ${order.userId}`);
    }

    return interaction.reply({
      content: `✅ Order **${orderId}** confirmed. Buyer has been notified via DM @1mjustkael_ .`,
      ephemeral: true,
    });
  }

  // ── Button: Admin cancels order ────────────
  if (interaction.isButton() && interaction.customId.startsWith('cancel_order:')) {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const orderId = interaction.customId.split(':')[1];
    const order   = orders.get(orderId);

    if (!order)  return interaction.reply({ content: '❌ Order not found.', ephemeral: true });
    if (!['pending', 'accepted'].includes(order.status))
      return interaction.reply({ content: `⚠️ Order is already **${order.status}**.`, ephemeral: true });

    // Release reserved stock for cancelled orders (support multi-item)
    if (Array.isArray(order.items)) {
      for (const it of order.items) {
        if (inventory[it.fruit]) inventory[it.fruit].reserved = Math.max(0, (inventory[it.fruit].reserved || 0) - it.qty);
      }
    } else if (inventory[order.fruit]) {
      inventory[order.fruit].reserved = Math.max(0, (inventory[order.fruit].reserved || 0) - order.qty);
    }
    order.status = 'cancelled';
    saveState();  // SAVE TO FILE

    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0xED4245)
      .setTitle(`CANCELLED — ${orderId}`)
      .addFields({ name: 'Cancelled By', value: interaction.user.tag, inline: true });

    await interaction.message.edit({ embeds: [updatedEmbed], components: [] });

    // Update the shop display in real-time
    await updateShopDisplay(interaction.guild);

    // DM buyer
    try {
      const buyerMember = await interaction.guild.members.fetch(order.userId);
      if (Array.isArray(order.items)) {
        const desc = order.items.map(it => `${it.fruit} × ${it.qty}`).join('\n');
        await buyerMember.send(
          `❌  Your order **${orderId}** has been **cancelled**.\n\nItems:\n${desc}\n\nIf you believe this is a mistake, please DM @1mjustkael_ directly.`
        );
      } else {
        await buyerMember.send(
          `❌  Your order **${orderId}** (${order.fruit} × ${order.qty}) has been **cancelled**.\n` +
          `If you believe this is a mistake, please DM @1mjustkael_ directly.`
        );
      }

    } catch { /* buyer has DMs off */ }

    return interaction.reply({
      content: `❌ Order **${orderId}** cancelled. Stock restored. Buyer notified.`,
      ephemeral: true,
    });
  }

  // ── Button: Leave a vouch ─────────────────
  if (interaction.isButton() && interaction.customId.startsWith('vouch_order:')) {
    const orderId = interaction.customId.split(':')[1];
    const order   = orders.get(orderId);

    if (!order)
      return interaction.reply({ content: '❌ Order not found.', ephemeral: true });

    try {
      const guild = client.guilds.cache.get(order.guildId) || await client.guilds.fetch(order.guildId);
      if (!guild) {
        return interaction.reply({ content: '❌ Unable to resolve the server for this order.', ephemeral: true });
      }

      await guild.channels.fetch();
      const vouchChannel = guild.channels.cache.find(
        c => c.name === CONFIG.VOUCH_CHANNEL && c.isTextBased()
      );

      if (!vouchChannel) {
        return interaction.reply({
          content: `❌ Vouch channel (#${CONFIG.VOUCH_CHANNEL}) not found. Contact an admin.`,
          ephemeral: true,
        });
      }

      const vouchEmbed = new EmbedBuilder()
        .setTitle('⭐ New Vouch')
        .setColor(0xFFD700)
        .addFields(
          { name: 'Buyer', value: `<@${order.userId}>`, inline: true },
        )
        .setTimestamp()
        .setFooter({ text: `Order ID: ${orderId}` });

      if (Array.isArray(order.items)) {
        const desc = order.items.map(it => `${it.fruit} × ${it.qty} — ₱${it.price * it.qty}`).join('\n');
        vouchEmbed.addFields({ name: 'Products', value: desc, inline: false }, { name: 'Subtotal', value: `₱${order.total}`, inline: true });
      } else {
        vouchEmbed.addFields({ name: 'Product', value: order.fruit || 'N/A', inline: true }, { name: 'Quantity', value: `${order.qty || 0}`, inline: true }, { name: 'Subtotal', value: `₱${order.total || 0}`, inline: true });
      }

      await vouchChannel.send({ embeds: [vouchEmbed] });

      return interaction.reply({
        content: '✅ Thank you for your vouch! It has been posted.',
        ephemeral: true,
      });
    } catch (err) {
      console.error('❌ Error posting vouch:', err);
      return interaction.reply({
        content: '❌ Failed to post vouch. Please try again.',
        ephemeral: true,
      });
    }
  }

});
client.login(process.env.DISCORD_TOKEN);