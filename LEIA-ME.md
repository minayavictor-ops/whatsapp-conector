# Conector do WhatsApp (Máquina de Leads)

Servidor pequeno que fica conectado ao WhatsApp como um aparelho a mais (igual ao WhatsApp Web) e entrega à Máquina de Leads os contatos dos grupos, da agenda e das conversas. Ele só lê: não envia mensagens, não marca nada como lido e deixa o celular recebendo as notificações normalmente.

## Como funciona

A tela do extrator fica em `vaileads.netlify.app/whatsapp/`, protegida pela mesma senha do site. A função `whatsapp` do Netlify confere a senha e repassa cada pedido a este servidor com um token secreto. Sem o token, este servidor recusa tudo, inclusive a tela.

O login é feito pela própria tela: QR Code (em Aparelhos conectados, no celular) ou código de 8 letras (Conectar com número de telefone), para quando a pessoa está no próprio celular.

## Arquivos

- `index.mjs`: liga o servidor e retoma a sessão salva, se houver.
- `sessao.mjs`: conexão com o WhatsApp (biblioteca Baileys), sincronização de contatos, leitura dos grupos e extração.
- `server.mjs`: endereços da API e entrega da tela, todos exigindo o token.
- `public/`: a tela do extrator (usa o visual e o gerador de planilhas da Máquina de Leads).

## Render

Web Service Node, região Ohio, plano Starter. Comando de build `npm install` e de início `node index.mjs`. Variável obrigatória: `CONECTOR_TOKEN`, igual à `WHATSAPP_CONECTOR_TOKEN` do Netlify. No Netlify também vai `WHATSAPP_CONECTOR_URL` com o endereço deste serviço.

A sessão do WhatsApp fica no disco do serviço. No plano Starter esse disco é apagado a cada nova publicação ou reinício, e aí basta ler o QR Code de novo. Para não precisar reconectar nunca, adicione um disco no Render (1 GB basta) montado em `/var/data` e crie a variável `PASTA_SESSAO=/var/data/sessao`.

## Atualizar a biblioteca do WhatsApp

Se um dia a conexão começar a falhar sem motivo, o WhatsApp pode ter mudado algo. Troque a versão de `baileys` no `package.json` pela mais recente (npmjs.com/package/baileys) e publique de novo.

## Cuidados

O WhatsApp não autoriza oficialmente programas como este e pode bloquear números que fazem disparos em massa. A leitura de contatos é discreta, mas evite mandar mensagens em massa para os números extraídos pelo seu número principal. Pela LGPD, use os contatos com base legal (por exemplo, legítimo interesse em prospecção B2B) e atenda pedidos de descadastro.
