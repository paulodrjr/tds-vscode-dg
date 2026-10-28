# TDS: Geração de pacote de atualização (_patch_)

> Requisitos
>
> - servidor/ambiente conectado
>
> Recomenda-se que pastas e arquivos não contenham caracteres especiais e/ou acentuados e sempre em mínusculas de forma a manter a compatibildade entre os diversos sistemas operacionais suportados pelo **TDS-VSCode** e seus componentes.
> Leia [Convenção para nomenclatura de File System em ambiente Linux]<https://tdn.totvs.com/x/h8BICw>).

## Geração de pacote de atualização (_patch_) a partir do RPO

Na visão `Servers`, acione o menu de contexto no servidor conectado e acione `Patch Generation` ou acione o atalho `CTRL + SHIFT + P` e execute `TOTVS: Patch Generation`.

- Aguarde a carga dos arquivos do inspetor de objetos
- Selecione os arquivos que deseja colocar no pacote utilizando o campo de `Filtro`, digitando um padrão de seleção e pressione `Enter`
- Selecione os arquivos da lista da esquerda e mova-os para lista da direita utilizando o botão `>>`
- Repita o processo, até que tenha selecionado todos os arquivos necessários
- Selecione o `diretório` onde o pacote será salvo
- Escolha o `nome do arquivo` de Patch desejado. (Quando não informado, o patch será gerado com o nome do RPO).
- Efetue e geração do Patch pressionando o botão `Gerar`.

![Patch Generate](./gifs/GeneratePatchWizard.gif)

No lugar de selecionar os arquivos manualmente, é possível gerar o pacote a partir de uma pasta, acionando o menu de contexto sobre a pasta e acionando `Generate Patch From Folder`. Também é possível gerar o pacote a partir de uma lista de fontes, importando um arquivo no formato TXT, onde cada linha é identifica um arquivo-fonte e este deve existir no RPO. Linhas iniciadas com `#` são ignoradas.

## Geração de pacote de atualização (_patch_) a partir de pastas (_From Folder_)

- Acione o menu de contexto sobre a pasta que contem os fontes a serem empacotados e acione `Generate Patch From m Folder)`
- Selecione uma pasta para salvar o pacote gerado
- Informe o nome do pacote que será gerado. Quando não informado, o pacote terá o mesmo do RPO, exceto pela extensão
- Após as confirmações, o pacote será gerado na pasta indicada

![Patch Generate Folder](./gifs/GeneratePatchWizardFromFolder.gif)

## Compilar e gerar patch a partir do Explorer

Na visão **Explorer** do VS Code, selecione um ou mais arquivos, pastas ou uma
combinação dos dois. Clique com o botão direito e escolha **TOTVS: Compilar e gerar patch**.

A extensão:

1. Percorre as pastas selecionadas, respeitando `.tdscompileignore` e
   `.tdspatchignore`, a lista de arquivos ignorados e as extensões permitidas
   nas configurações de compilação.
2. Exclui `.ch` e `.th`, que são includes e não objetos do RPO, e impede
   a geração caso haja arquivos com o mesmo nome em diretórios diferentes.
3. Solicita o diretório de destino e o nome do patch (opcional).
4. Exibe uma confirmação com o servidor, ambiente e quantidade de arquivos.
5. **Recompila** os arquivos selecionados, aguardando o retorno do Language Server.
6. Não gera patch se ocorrer erro de compilação ou se a sessão mudar.
   Havendo avisos (`WARN`), solicita autorização explícita para continuar.
7. Gera o patch a partir dos nomes dos arquivos recompilados que foram incluídos no RPO.

O comando antigo **Generate Patch From Folder** permanece registrável, mas
agora utiliza o mesmo fluxo protegido, sem iniciar a geração antes do fim da
compilação.

**Importante:** a seleção de fontes é local; os objetos empacotados são
extraídos do RPO do AppServer conectado. Execute em desenvolvimento ou homologação,
nunca em produção sem um procedimento controlado.
