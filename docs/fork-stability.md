# Ajustes de estabilidade do fork TDS-VSCode

Esta versão usa a identidade original `TOTVS.tds-vscode` para substituir a extensão oficial instalada pelo VSIX. Os fontes e as correções são mantidos no fork, sem publicação no Marketplace.

## Instalação e recuperação

No checkout do fork:

```powershell
git pull origin master
npm install
npm run package
```

Instale o VSIX gerado via **Extensions: Install from VSIX**. O GitHub Actions também valida o empacotamento na branch `master`; quando concluído com sucesso, o VSIX fica disponível como artefato temporário do workflow.

## Compilação

- O comando **TOTVS: Check AppServer Connection** faz uma consulta remota para verificar a sessão.
- Após o período configurado em `totvsLanguageServer.compilation.unresponsiveWarningSeconds` (padrão: 600 segundos), a extensão emite um aviso, mas **não presume** que a compilação remota acabou.
- O comando **TOTVS: Reset Local Compilation Lock** libera apenas o bloqueio local. Use-o **somente depois de confirmar que a compilação no AppServer terminou**. A liberação não encerra o processamento remoto.
- A fila de compilação ignora respostas antigas que chegarem depois de uma recuperação ou reinicialização do Language Server.

## Conexão

Uma sessão antiga não deve substituir uma conexão mais recente depois que o usuário trocar de ambiente. Uma reconexão com token inválido pode iniciar uma nova autenticação. A verificação de conexão disponível pelo comando é manual: não há sondagem periódica padrão que possa interromper sessões por falsos positivos.

## Depuração

A extensão valida a pasta de trabalho (CWB), o programa, os argumentos, a sessão do AppServer e a existência do Debug Adapter antes de iniciar.

A TOTVS recomenda executar diretamente módulos como `SIGAFAT`, `SIGAEST` e `SIGACOM` em vez de iniciar a depuração pelo menu `SIGAMDI` ou `SIGAADV`. A extensão mantém a possibilidade de prosseguir mediante confirmação. Falhas internas de classes, patches ou ambiente do Protheus não podem ser corrigidas apenas no cliente VS Code.

## Configuração e logs

O arquivo `servers.json` não é mais tratado como uma configuração vazia quando seu conteúdo JSON é inválido. Nesse caso, a extensão exige que o arquivo seja corrigido, preservando o original. A captura de suporte gera um ZIP verdadeiro, aguardando sua conclusão antes de reportar sucesso.

O armazenamento e o tratamento de segurança dos tokens permanecem inalterados por solicitação.

## Verificação

```powershell
npm run package
npm run compile-test
```

Os testes de integração com o AppServer exigem um ambiente de homologação. Não execute debug ou compilação diretamente em produção para validar essas mudanças.
