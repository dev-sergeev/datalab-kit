# Технические заметки к требованиям Datalab Kit

Это результаты предварительного исследования, а не согласованная архитектура. При реализации нужно сверять исходники выбранных версий и проверять фактическое поведение установленного npm-архива.

## Ресурсы и конфигурация

Манифест Pi раскрывает расширения, навыки, промпты и темы. Он сам по себе не доставляет JSON-настройки permission system и subagents. Документация также требует включать зависимые Pi-пакеты в опубликованный архив, если их ресурсы раскрываются через пути `node_modules/...` в манифесте. [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

Permission system читает глобальный и проектный конфиги. В исследованной версии `33.0.5` есть также устаревший путь к конфигу внутри самого расширения, который вызывает предупреждение о миграции; это не выбранный способ доставки значений по умолчанию. [Конфигурация](https://github.com/gotgenes/pi-packages/blob/main/packages/pi-permission-system/docs/configuration.md), [загрузчик](https://github.com/gotgenes/pi-packages/blob/main/packages/pi-permission-system/src/config/config-loader.ts).

Subagents `21.7.5` поддерживает `maxConcurrent: 1` через глобальный или проектный `subagents.json`. В исследованном публичном API нет метода изменения этого значения из другого расширения. [Конфигурация](https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/docs/configuration.md#persistent-settings), [настройки](https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/src/settings.ts).

## Диалог подтверждения

В точном npm-архиве permission system `33.0.5` начальное действие — разрешение. Enter немедленно подтверждает выбранное действие; `doublePressToConfirm` защищает буквенные горячие клавиши, но не Enter. Следующее действие после стрелки вниз — разрешение на всю сессию. Поэтому согласованного поведения нельзя достичь только включением `doublePressToConfirm`: нужна адаптация диалога. [Исходники](https://github.com/gotgenes/pi-packages/blob/main/packages/pi-permission-system/src/authority/permission-prompt-decision.ts), [точный npm-архив](https://registry.npmjs.org/@gotgenes/pi-permission-system/-/pi-permission-system-33.0.5.tgz).

Текстового шаблона с подстрокой `localhost` недостаточно для исключения сетевого запроса: нужно учитывать действительный адрес, метод запроса и действие всей команды. Проверка не должна автоматически разрешать изменение данных лишь из-за имени инструмента чтения. [Правила bash](https://github.com/gotgenes/pi-packages/blob/main/packages/pi-permission-system/docs/configuration.md#bash-command-patterns).

## Обновление GigaChat

В исследованном менеджере пакетов Pi стандартное обновление сравнивает версии объявленных пакетов и пропускает npm-пакет, если его версия не изменилась. Поэтому зависимость `latest` внутри неизменившегося Datalab Kit сама по себе не обеспечивает обновление GigaChat стандартной командой. Способ подключения должен отдельно обеспечить согласованный сценарий обновления без нового выпуска набора. [Менеджер пакетов Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/package-manager.ts).

Исследование пока не доказывает, что конкретный механизм установки, регистрации и удаления компонентов выполняет все требования. Архитектура подключения ещё не выбрана.
