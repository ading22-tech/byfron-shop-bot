const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  Events, REST, Routes, SlashCommandBuilder, PermissionFlagsBits
} = require('discord.js');

require('dotenv').config();

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
  ADMIN_ROLE:       'Admin',        // role name that can confirm/cancel
};

// ─────────────────────────────────────────────
//  FRUIT INVENTORY  (edit prices / stock freely)
// ─────────────────────────────────────────────
const inventory = {
  kitsune:   { price: 145, stock: 1, emoji: '🦊' },
  gas:       { price: 30,  stock: 2, emoji: '💨' },
  yeti:      { price: 50,  stock: 1, emoji: '❄️'  },
  tiger:     { price: 55,  stock: 1, emoji: '🐯' },
  buddha:    { price: 10,  stock: 3, emoji: '☯️'  },
  portal:    { price: 10,  stock: 3, emoji: '🌀' },
  dragon:    { price: 0,   stock: 0, emoji: '🐉' },
  trex:      { price: 20,  stock: 1, emoji: '🦖' },
  mammoth:   { price: 20,  stock: 3, emoji: '🦣' },
  venom:     { price: 45,  stock: 2, emoji: '🐍' },
  lightning: { price: 30,  stock: 1, emoji: '⚡' },
  dough:     { price: 20,  stock: 3, emoji: '🍞' },
};

// In-memory order store. Replace with a JSON file or SQLite for persistence.
const orders = new Map();
let orderCounter = 1;

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function isAdmin(member) {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.roles.cache.some(r => r.name === CONFIG.ADMIN_ROLE)
  );
}

function buildShopEmbed() {
  const available = Object.entries(inventory)
    .filter(([, v]) => v.stock > 0)
    .map(([name, v]) => `${v.emoji} **${name}** — ₱${v.price}  \`[${v.stock} in stock]\``)
    .join('\n');

  const oos = Object.entries(inventory)
    .filter(([, v]) => v.stock === 0)
    .map(([name, v]) => `${v.emoji} ~~${name}~~ — out of stock`)
    .join('\n');

  return new EmbedBuilder()
    .setTitle('🏪  byfron\'s bloxfruit shop')
    .setDescription(
      'Pick a fruit below and click **🛒 Order Now** to start your order.\n' +
      '> **Payment:** GCash and PayPal only\n' +
      '> **Support:** DM @1mjustkael_'
    )
    .setColor(0xFFD700)
    .addFields(
      { name: '✅  Available', value: available || '_No fruits in stock_', inline: false },
      { name: '❌  Out of Stock', value: oos || '_None_', inline: false },
    )
    .setFooter({ text: 'byfron services • bloxfruit shop' })
    .setTimestamp();
}

function buildFruitMenu() {
  const options = Object.entries(inventory)
    .filter(([, v]) => v.stock > 0)
    .map(([name, v]) => ({
      label: `${name}  —  ₱${v.price}`,
      description: `${v.stock} in stock`,
      value: name,
      emoji: v.emoji,
    }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_fruit')
      .setPlaceholder('Choose a fruit…')
      .addOptions(options)
  );
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
    .setName('orders')
    .setDescription('List all pending orders (Admin only)')
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

    await interaction.channel.send({
      embeds: [buildShopEmbed()],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('start_order')
            .setLabel('🛒  Order Now')
            .setStyle(ButtonStyle.Success)
        )
      ],
    });
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
    return interaction.reply({
      content: `✅ **${fruit}** stock updated to **${amount}**.`,
      ephemeral: true,
    });
  }

  // ── /orders ────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'orders') {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const pending = [...orders.values()].filter(o => o.status === 'pending');
    if (pending.length === 0)
      return interaction.reply({ content: '📭 No pending orders.', ephemeral: true });

    const list = pending
      .map(o => `\`${o.orderId}\` — ${o.fruit} x${o.qty}  (${o.username})`)
      .join('\n');

    return interaction.reply({ content: `**📋 Pending Orders:**\n${list}`, ephemeral: true });
  }

  // ── Button: "Order Now" ────────────────────
  if (interaction.isButton() && interaction.customId === 'start_order') {
    const hasStock = Object.values(inventory).some(v => v.stock > 0);
    if (!hasStock)
      return interaction.reply({ content: '😔 All fruits are currently out of stock. Check back later!', ephemeral: true });

    return interaction.reply({
      content: '**Step 1 of 2 —** Select the fruit you want:',
      components: [buildFruitMenu()],
      ephemeral: true,
    });
  }

  // ── Select Menu: fruit chosen ──────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_fruit') {
    const fruit = interaction.values[0];
    const f     = inventory[fruit];

    return interaction.reply({
      content:
        `You selected  ${f.emoji} **${fruit}**  — ₱${f.price}\n` +
        `*(${f.stock} in stock)*\n\n` +
        `**Step 2 of 2 —** Click below to fill in your order details.`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`fill_order:${fruit}`)
            .setLabel('📝  Fill Order Form')
            .setStyle(ButtonStyle.Primary)
        )
      ],
      ephemeral: true,
    });
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
    const fruit = interaction.customId.split(':')[1];
    const f     = inventory[fruit];

    const qty           = Math.max(1, parseInt(interaction.fields.getTextInputValue('quantity')) || 1);
    const paymentMethod = interaction.fields.getTextInputValue('payment_method').toLowerCase().trim();
    const accountInfo   = interaction.fields.getTextInputValue('account_info').trim();
    const reference     = interaction.fields.getTextInputValue('reference').trim();
    const gameUsername  = interaction.fields.getTextInputValue('game_username').trim();

    if (qty > f.stock) {
      return interaction.reply({
        content: `❌ Only **${f.stock}** ${fruit} left in stock. Please adjust your quantity.`,
        ephemeral: true,
      });
    }

    const total   = f.price * qty;
    const orderId = `ORD-${String(orderCounter++).padStart(4, '0')}`;

    orders.set(orderId, {
      orderId, userId: interaction.user.id, username: interaction.user.tag,
      fruit, qty, total, paymentMethod, accountInfo, reference, gameUsername,
      status: 'pending', timestamp: new Date().toISOString(),
    });

    inventory[fruit].stock -= qty;

    // Post to admin receipts channel
    const guild           = interaction.guild;
    const receiptsChannel = guild.channels.cache.find(c => c.name === CONFIG.RECEIPTS_CHANNEL);
    const ordersChannel   = guild.channels.cache.find(c => c.name === CONFIG.ORDERS_CHANNEL);

    if (receiptsChannel) {
      const orderEmbed = new EmbedBuilder()
        .setTitle(`📦  New Order — ${orderId}`)
        .setColor(0xFFA500)
        .addFields(
          { name: '👤 Customer',         value: `<@${interaction.user.id}>\n${interaction.user.tag}`,  inline: true },
          { name: '🎮 In-Game Name',      value: gameUsername,  inline: true },
          { name: '🍎 Fruit',             value: `${f.emoji} ${fruit}`,  inline: true },
          { name: '🔢 Quantity',          value: `${qty}`,      inline: true },
          { name: '💰 Total Amount',      value: `₱${total}`,   inline: true },
          { name: '💳 Payment Method',    value: paymentMethod.toUpperCase(), inline: true },
          { name: '📱 Buyer Account',     value: accountInfo,   inline: true },
          { name: '🧾 Reference #',       value: `\`${reference}\``, inline: false },
        )
        .setTimestamp()
        .setFooter({ text: `Order ID: ${orderId}` });

      await receiptsChannel.send({
        content: `🔔  **@here** — New order from <@${interaction.user.id}>. Verify payment then confirm below.`,
        embeds: [orderEmbed],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`confirm_order:${orderId}`)
              .setLabel('✅  Confirm & Deliver')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`cancel_order:${orderId}`)
              .setLabel('❌  Cancel Order')
              .setStyle(ButtonStyle.Danger),
          )
        ],
      });
    }

    // Tell the buyer what to do next
    return interaction.reply({
      content:
        `✅  **Order placed!**\n\n` +
        `> 📋 Order ID: \`${orderId}\`\n` +
        `> ${f.emoji} **${fruit}** × ${qty}  =  **₱${total}**\n\n` +
        `📸  Please send your **payment screenshot** to ${ordersChannel ? `<#${ordersChannel.id}>` : `#${CONFIG.ORDERS_CHANNEL}`} ` +
        `and include your Order ID \`${orderId}\` in the message.\n\n` +
        `You'll receive a **DM** once your order is confirmed. Thank you! 🙏`,
      ephemeral: true,
    });
  }

  // ── Button: Admin confirms order ───────────
  if (interaction.isButton() && interaction.customId.startsWith('confirm_order:')) {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });

    const orderId = interaction.customId.split(':')[1];
    const order   = orders.get(orderId);

    if (!order)  return interaction.reply({ content: '❌ Order not found.', ephemeral: true });
    if (order.status !== 'pending')
      return interaction.reply({ content: `⚠️ Order is already **${order.status}**.`, ephemeral: true });

    order.status      = 'confirmed';
    order.confirmedBy = interaction.user.tag;

    // Edit the receipts-channel embed to green
    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0x57F287)
      .setTitle(`✅  CONFIRMED — ${orderId}`)
      .addFields({ name: '✅ Confirmed By', value: interaction.user.tag, inline: true });

    await interaction.message.edit({ embeds: [updatedEmbed], components: [] });

    // DM the buyer
    try {
      const buyerMember = await interaction.guild.members.fetch(order.userId);
      await buyerMember.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('🎉  Your order has been confirmed!')
            .setColor(0x57F287)
            .setDescription(
              `Your payment was verified and your order is being delivered.\n` +
              `Please **go online in Blox Fruits** and wait for the trade!\n\n` +
              `Thank you for shopping at **byfron services** 🙏`
            )
            .addFields(
              { name: '📋 Order ID',      value: orderId,         inline: true },
              { name: '🍎 Fruit',         value: order.fruit,     inline: true },
              { name: '🎮 In-Game Name',  value: order.gameUsername, inline: true },
            )
            .setTimestamp()
        ]
      });
    } catch {
      console.warn(`Could not DM buyer ${order.userId}`);
    }

    return interaction.reply({
      content: `✅ Order **${orderId}** confirmed. Buyer has been notified via DM.`,
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
    if (order.status !== 'pending')
      return interaction.reply({ content: `⚠️ Order is already **${order.status}**.`, ephemeral: true });

    // Restore stock
    if (inventory[order.fruit]) inventory[order.fruit].stock += order.qty;
    order.status = 'cancelled';

    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0xED4245)
      .setTitle(`❌  CANCELLED — ${orderId}`)
      .addFields({ name: '❌ Cancelled By', value: interaction.user.tag, inline: true });

    await interaction.message.edit({ embeds: [updatedEmbed], components: [] });

    // DM buyer
    try {
      const buyerMember = await interaction.guild.members.fetch(order.userId);
      await buyerMember.send(
        `❌  Your order **${orderId}** (${order.fruit} × ${order.qty}) has been **cancelled**.\n` +
        `If you believe this is a mistake, please DM @somin directly.`
      );
    } catch { /* buyer has DMs off */ }

    return interaction.reply({
      content: `❌ Order **${orderId}** cancelled. Stock restored. Buyer notified.`,
      ephemeral: true,
    });
  }

});

client.login(process.env.DISCORD_TOKEN);
