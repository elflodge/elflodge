# Changelog

## [0.11.0](https://github.com/elflodge/elflodge/compare/v0.10.0...v0.11.0) (2026-11-25)


### ⚠ BREAKING CHANGES

* **api:** POST /batches/{id}/jobs answers each job by its id and customId alone, and `elflodge jobs submit` and `elflodge batches add-jobs` print only those two for each job; read the rest from GET /jobs/{id} (`jobs get`).
* **contract:** a 0.10.0 CLI prints "Output validation failed" on `elflodge jobs submit`, `jobs get` and `jobs list` against this hub, and the hub may already have accepted a job it submitted. Upgrade the CLI with the hub: `elflodge@X` is the CLI for hub X.
* GET /runners and GET /api-keys now answer 400 naming an unknown query parameter; v0.10.0 ignored it and returned the listing.
* **hub:** the hub no longer serves a browsable API reference, which v0.10.0 served at /; / now redirects to the dashboard, and the OpenAPI document at /spec.json still describes every public call and its parameters.
* GET /jobs refuses `status[]=` and `status[0]=` with 400 instead of ignoring the filter; send one `status` parameter per value, as the API reference shows.
* this release's migration renames the submitter columns, so stop the previous hub before starting this one; the hub restarts across the upgrade rather than running beside the earlier version.

### Features

* **adapter:** run Pi extension model providers in durable conversations ([#238](https://github.com/elflodge/elflodge/issues/238)) ([4135626](https://github.com/elflodge/elflodge/commit/4135626d26c81becaa0a304997d09fed62c4735e))
* answer usage with ranked groups and daily totals, counting job ends ([#201](https://github.com/elflodge/elflodge/issues/201)) ([7801f35](https://github.com/elflodge/elflodge/commit/7801f3559a4e7c30ccef1c2cc1fc2d86cd701bfc))
* **api:** say in each refusal which part of the request each problem concerns ([#224](https://github.com/elflodge/elflodge/issues/224)) ([f8e940e](https://github.com/elflodge/elflodge/commit/f8e940e043b149d84b39545f8b10ddc309b7c909))
* **api:** take up to 1,000 jobs per request and answer each job by its IDs ([#232](https://github.com/elflodge/elflodge/issues/232)) ([6b71b76](https://github.com/elflodge/elflodge/commit/6b71b7648e70ecdfdca84c8341f0e6b581bf38e0))
* **batches:** say on each Batch how many queued jobs each reason blocks ([#221](https://github.com/elflodge/elflodge/issues/221)) ([ba1ed36](https://github.com/elflodge/elflodge/commit/ba1ed36aaba2bef2f734661da7018ff721f65cfc))
* count the Organization's unfinished jobs with GET /jobs/counts ([#184](https://github.com/elflodge/elflodge/issues/184)) ([2a6e845](https://github.com/elflodge/elflodge/commit/2a6e845699969767ba97ade8ffacb2cc255273b4))
* **dashboard:** add the Runners and API keys pages, with Add Runner ([#202](https://github.com/elflodge/elflodge/issues/202)) ([a8dabf2](https://github.com/elflodge/elflodge/commit/a8dabf2f2dc44c1ec4abefdf9dfeb184d6fb6fd4))
* **dashboard:** confirm a job's and a Batch's controls with UI SDK ([#260](https://github.com/elflodge/elflodge/issues/260)) ([376a1d0](https://github.com/elflodge/elflodge/commit/376a1d02ff166457c0f7c3b24ed88b14140a9e4f))
* **dashboard:** confirm Runner removal and key revocation with UI SDK ([#255](https://github.com/elflodge/elflodge/issues/255)) ([a70daeb](https://github.com/elflodge/elflodge/commit/a70daeb3f5a06b0c507628c487ae4c5d5cc83f5c))
* **dashboard:** confirm the Organization page's Remove, Leave and Revoke with UI SDK ([#268](https://github.com/elflodge/elflodge/issues/268)) ([1147929](https://github.com/elflodge/elflodge/commit/11479290ce2c92819ed7326b4b324cf65d0a1822))
* **dashboard:** connect form fields with UI SDK ([#291](https://github.com/elflodge/elflodge/issues/291)) ([0dc355d](https://github.com/elflodge/elflodge/commit/0dc355d29d941761443a5839ac1bef70492807cc))
* **dashboard:** follow a job's Events and page through its history ([#216](https://github.com/elflodge/elflodge/issues/216)) ([9f762ee](https://github.com/elflodge/elflodge/commit/9f762ee8e206c3ab9bbaf93738f746ac52a309bb))
* **dashboard:** give the dashboard its design system ([#183](https://github.com/elflodge/elflodge/issues/183)) ([d55e907](https://github.com/elflodge/elflodge/commit/d55e9071a2a84b846a7538ff0ef0852b6494a460))
* **dashboard:** keep Add Runner open while creating a key ([#278](https://github.com/elflodge/elflodge/issues/278)) ([ae8f0b2](https://github.com/elflodge/elflodge/commit/ae8f0b2d11d2dba4b1329178d40037e9afa1980b))
* **dashboard:** keep Create key open while the hub answers, on UI SDK's dialog ([#271](https://github.com/elflodge/elflodge/issues/271)) ([fbfeaed](https://github.com/elflodge/elflodge/commit/fbfeaedeeb839203d2493cc907f034703606a81e))
* **dashboard:** keep Organization forms open while the hub answers ([#274](https://github.com/elflodge/elflodge/issues/274)) ([cbd7638](https://github.com/elflodge/elflodge/commit/cbd76384aa94ea1aec72e3e8325350e810d2ded6))
* **dashboard:** keep pending page controls focusable with UI SDK ([#283](https://github.com/elflodge/elflodge/issues/283)) ([787fb5c](https://github.com/elflodge/elflodge/commit/787fb5cdb124f7bcc79ca30d5dadc59fcfde7ccd))
* **dashboard:** keep the resume budget dialog open while the hub answers ([#279](https://github.com/elflodge/elflodge/issues/279)) ([8b9cfbb](https://github.com/elflodge/elflodge/commit/8b9cfbbd0be529e041d304566d0273ea5b8210a6))
* **dashboard:** lay the groundwork for the dashboard's pages ([#192](https://github.com/elflodge/elflodge/issues/192)) ([969d26e](https://github.com/elflodge/elflodge/commit/969d26ea36898c3621e899a3036f1d0abbcca7f9))
* **dashboard:** let an invited person join from an invitation link ([#209](https://github.com/elflodge/elflodge/issues/209)) ([7006cca](https://github.com/elflodge/elflodge/commit/7006cca817b32ea6961db9c213a985703dd75425))
* **dashboard:** let members browse Batches and pause, resume or cancel them ([#220](https://github.com/elflodge/elflodge/issues/220)) ([135c911](https://github.com/elflodge/elflodge/commit/135c9111e69223dc77cb914a97706f70a2b18f66))
* **dashboard:** let members manage their Organization from the dashboard ([#213](https://github.com/elflodge/elflodge/issues/213)) ([15371d5](https://github.com/elflodge/elflodge/commit/15371d55b5c71e0bb4fc6e9ed0deb1aafcd8d829))
* **dashboard:** let members open a job and act on it ([#214](https://github.com/elflodge/elflodge/issues/214)) ([4b061c9](https://github.com/elflodge/elflodge/commit/4b061c9c30c2f55eb2f8cf75ef7b98a7c17eb4d0))
* **dashboard:** let members see and filter the Organization's jobs ([#211](https://github.com/elflodge/elflodge/issues/211)) ([13e0e9b](https://github.com/elflodge/elflodge/commit/13e0e9be258b68932ab97620ea0ce2f82e583cee))
* **dashboard:** move the account menu onto UI SDK's Popover ([#299](https://github.com/elflodge/elflodge/issues/299)) ([193a648](https://github.com/elflodge/elflodge/commit/193a648cfa9ac851120e109357493ccf6af4b5fd))
* **dashboard:** pick and drop Batch files through UI SDK's FileInput ([#300](https://github.com/elflodge/elflodge/issues/300)) ([d182ef8](https://github.com/elflodge/elflodge/commit/d182ef8c55ad018b0e112144bd6a9eec27d9eac2))
* **dashboard:** show a job's and a Batch's tool calls ([#253](https://github.com/elflodge/elflodge/issues/253)) ([7de34d4](https://github.com/elflodge/elflodge/commit/7de34d4ff8ffebef73f4c3f6d8e8d0e278a3db12))
* **dashboard:** show the Organization's usage by day and by group over a chosen period ([#223](https://github.com/elflodge/elflodge/issues/223)) ([1f5de8d](https://github.com/elflodge/elflodge/commit/1f5de8de20b9bacd67699a3e6b2c157915b4e3bb))
* **dashboard:** submit a Batch from the Batches page ([#237](https://github.com/elflodge/elflodge/issues/237)) ([28911d6](https://github.com/elflodge/elflodge/commit/28911d62a2987206dcc9344995d1d1990d365ef8))
* **dashboard:** submit a job from the Jobs page ([#233](https://github.com/elflodge/elflodge/issues/233)) ([b7ea372](https://github.com/elflodge/elflodge/commit/b7ea37273c45b5dcb165d26b454cdcd3c704967e))
* **dashboard:** title each page and make the pages agree ([#239](https://github.com/elflodge/elflodge/issues/239)) ([35f7855](https://github.com/elflodge/elflodge/commit/35f7855c63f958cc47d4417cc5ded5c65c3140dd))
* **hub:** count each job's tool calls ([#252](https://github.com/elflodge/elflodge/issues/252)) ([4b32b8e](https://github.com/elflodge/elflodge/commit/4b32b8ee36e233c7b318ff19fd04fa35cab749d5))
* **hub:** count unknown-status jobs by status in the Organization's counts ([#195](https://github.com/elflodge/elflodge/issues/195)) ([3820134](https://github.com/elflodge/elflodge/commit/3820134853ec44f1e6c6b7d26ec0acf241c67067))
* **hub:** create a Batch with its first jobs atomically ([#229](https://github.com/elflodge/elflodge/issues/229)) ([4cbd13d](https://github.com/elflodge/elflodge/commit/4cbd13d611c40c67ea5d6e26e3cbb7c17295089a))
* **hub:** keep each Usage record's use by model and by tool ([#251](https://github.com/elflodge/elflodge/issues/251)) ([2eac749](https://github.com/elflodge/elflodge/commit/2eac749c16ac0c34913603bd4f5504d447d3cef8))
* **hub:** let an invited person join the Organization ([#207](https://github.com/elflodge/elflodge/issues/207)) ([81e238b](https://github.com/elflodge/elflodge/commit/81e238b7065d66084035f80fc1cedaed136cce5d))
* **hub:** let callers read the job limits' defaults and maxima ([#208](https://github.com/elflodge/elflodge/issues/208)) ([a281d97](https://github.com/elflodge/elflodge/commit/a281d97c022be3702eaae009fb5009b5d2160980))
* **hub:** read a job's events newest first ([#205](https://github.com/elflodge/elflodge/issues/205)) ([e2f4159](https://github.com/elflodge/elflodge/commit/e2f4159ce1a30e48cdce52dd59223887a0d8c111))
* **hub:** read a member's Organization and role with their session ([#194](https://github.com/elflodge/elflodge/issues/194)) ([2486cc4](https://github.com/elflodge/elflodge/commit/2486cc4d9ded408e25473b470a1366b6a1a45124))
* **hub:** remove the browsable API reference and keep /spec.json ([#196](https://github.com/elflodge/elflodge/issues/196)) ([9a6e4eb](https://github.com/elflodge/elflodge/commit/9a6e4eba5e3ad14cc658700d12d621875a06ee71))
* let a key read the Runner listing, and stop the stack signing in on each start ([#198](https://github.com/elflodge/elflodge/issues/198)) ([10ae9c8](https://github.com/elflodge/elflodge/commit/10ae9c8a9d84bef4a4125669f7f3415d09aa323f))
* let members submit with their session and show who submitted ([#187](https://github.com/elflodge/elflodge/issues/187)) ([9211cc1](https://github.com/elflodge/elflodge/commit/9211cc14c635241bd02dcc194b9ab65bf7b613d8))
* list a Runner's jobs with GET /jobs?runnerId= ([#180](https://github.com/elflodge/elflodge/issues/180)) ([01369a0](https://github.com/elflodge/elflodge/commit/01369a0ba00b01a32fe2d55037c36ce70fca9b9a))
* list Batches with GET /batches ([#181](https://github.com/elflodge/elflodge/issues/181)) ([af1cf1c](https://github.com/elflodge/elflodge/commit/af1cf1cfeb548009ae39d0c1fa8208330680a805))
* read the job with its Events at the newest end of the journal ([#222](https://github.com/elflodge/elflodge/issues/222)) ([e7b9736](https://github.com/elflodge/elflodge/commit/e7b97362de53a445bb8ea6a48ad1995dc6ce1167))
* read the Organization's usage by day and by group ([#185](https://github.com/elflodge/elflodge/issues/185)) ([f87bc06](https://github.com/elflodge/elflodge/commit/f87bc06367fb02ab7709609725b59cb2e42c1e0e))
* **runner:** give each job its own Pi model runtime for extension providers ([#305](https://github.com/elflodge/elflodge/issues/305)) ([7fa4a58](https://github.com/elflodge/elflodge/commit/7fa4a580d969433ab86716c06f5aec75f1a9de1e))
* **runner:** say at start when the Runner's own proxy leaves names unchecked ([#154](https://github.com/elflodge/elflodge/issues/154)) ([8b59a77](https://github.com/elflodge/elflodge/commit/8b59a7729c87048ea27ec2d00f614dd569f5aed3))
* **runner:** upgrade to Pi 1.6 and preserve tool usage counts ([#256](https://github.com/elflodge/elflodge/issues/256)) ([1a5d428](https://github.com/elflodge/elflodge/commit/1a5d42889d6c52616e13d33d4d7453d908fa2e9f))
* serve a signed-in dashboard from the hub ([#172](https://github.com/elflodge/elflodge/issues/172)) ([fa55920](https://github.com/elflodge/elflodge/commit/fa559209f701deeea1fb4d84a985ef1e43cd3835))
* set a new hub up from a link it prints ([#173](https://github.com/elflodge/elflodge/issues/173)) ([6ab5567](https://github.com/elflodge/elflodge/commit/6ab5567a49cc8e47a0d901fd970a3ac2dfaca589))
* show a job's status as unknown when its Runner goes silent ([#160](https://github.com/elflodge/elflodge/issues/160)) ([04f5023](https://github.com/elflodge/elflodge/commit/04f502328c84c7c1cf5d9f2daaaba8fb047e6cb1))
* show when Runners registered, and explain a refused registration key ([#177](https://github.com/elflodge/elflodge/issues/177)) ([e7941ad](https://github.com/elflodge/elflodge/commit/e7941adb02975857f8946b57cf5138d61d55b93b))


### Bug Fixes

* **cli:** show a Runner image's first pull in place on Compose before 5.7 ([#159](https://github.com/elflodge/elflodge/issues/159)) ([3c3853f](https://github.com/elflodge/elflodge/commit/3c3853f415e02407d5c6e9ea4fe4383a05eaa0ce)), closes [#158](https://github.com/elflodge/elflodge/issues/158)
* **contract:** read job reasons that a newer hub adds ([#228](https://github.com/elflodge/elflodge/issues/228)) ([95d0a88](https://github.com/elflodge/elflodge/commit/95d0a88cee88e2423e9abf93408e207ce5776144))
* **contract:** read responses with added members ([#226](https://github.com/elflodge/elflodge/issues/226)) ([20b2310](https://github.com/elflodge/elflodge/commit/20b2310286ea6b4620c03226eb0fd01155b4e2df))
* **contract:** require the six fields every listed job carries ([#204](https://github.com/elflodge/elflodge/issues/204)) ([be384ef](https://github.com/elflodge/elflodge/commit/be384efcee273ae396647c1f9a04d4946ee63163))
* correct hub health checks, auth renewal, and stack sign-in ([#215](https://github.com/elflodge/elflodge/issues/215)) ([91c7e4a](https://github.com/elflodge/elflodge/commit/91c7e4ae2471be10cf200d4f07a1278243aebd04))
* **dashboard:** clarify organization access and runner setup ([#304](https://github.com/elflodge/elflodge/issues/304)) ([48f9ae3](https://github.com/elflodge/elflodge/commit/48f9ae322f1824f4a4f4c1c6e81fc3ab85cf6b13))
* **dashboard:** keep a member's focus when a field is refused ([#217](https://github.com/elflodge/elflodge/issues/217)) ([c67e5ba](https://github.com/elflodge/elflodge/commit/c67e5ba310c13b2b33c8a10d910756caf876e910))
* **dashboard:** keep focus on Apply and read unchanged job filters in place ([#219](https://github.com/elflodge/elflodge/issues/219)) ([ccbfb4b](https://github.com/elflodge/elflodge/commit/ccbfb4b8376a5f245fbaeecf2046056ecbd35bdf))
* **dashboard:** keep focus on Resume when its control changes ([#296](https://github.com/elflodge/elflodge/issues/296)) ([238e7b2](https://github.com/elflodge/elflodge/commit/238e7b29202d05e206a17ceae3d40ed3baec3c31))
* **dashboard:** keep focus on the jobs filters after Apply ([9d9bf9e](https://github.com/elflodge/elflodge/commit/9d9bf9e22fe1e4a4b41670d3484b4e8340cec54e))
* **dashboard:** load pages on navigation and retry transient reads ([#303](https://github.com/elflodge/elflodge/issues/303)) ([f8a2e00](https://github.com/elflodge/elflodge/commit/f8a2e00d1fcb0cebb79676ddf64d4372747cf168))
* **dashboard:** never read a vanishing value through a Show's accessor ([#236](https://github.com/elflodge/elflodge/issues/236)) ([36b1fe0](https://github.com/elflodge/elflodge/commit/36b1fe051a24cc9f60acd9f84dab0afdc0d96feb))
* **dashboard:** say a Runner or key is already gone; refuse a long key name at its field ([#206](https://github.com/elflodge/elflodge/issues/206)) ([fb23190](https://github.com/elflodge/elflodge/commit/fb23190973852d38035dafce88ca7efc61e50aa3))
* **dashboard:** say that a Member's submissions spend money ([#248](https://github.com/elflodge/elflodge/issues/248)) ([26735b6](https://github.com/elflodge/elflodge/commit/26735b61dc459f9a7f1b41037ea5fd774e2caf08))
* **dashboard:** show the not-found page at an unknown address ([#182](https://github.com/elflodge/elflodge/issues/182)) ([67c3118](https://github.com/elflodge/elflodge/commit/67c311843af8cb12bcf581cd0b96dda478dc777a))
* **hub:** keep auth errors, paged reads and dashboard caching correct ([#191](https://github.com/elflodge/elflodge/issues/191)) ([d9f2927](https://github.com/elflodge/elflodge/commit/d9f2927d76e58484295093f30e19e8204fe5da1c))
* **hub:** leave answers open to new fields in the OpenAPI document ([#186](https://github.com/elflodge/elflodge/issues/186)) ([aa653f7](https://github.com/elflodge/elflodge/commit/aa653f738d42e92e45943cc0502a901b8d738f24))
* **hub:** let a setup link work for an hour instead of a day ([#249](https://github.com/elflodge/elflodge/issues/249)) ([096b31d](https://github.com/elflodge/elflodge/commit/096b31d49de71018ac5b3e5d4da5d0591867fdf3))
* **hub:** let only those who could grant an invitation replace it ([#212](https://github.com/elflodge/elflodge/issues/212)) ([9b1c30f](https://github.com/elflodge/elflodge/commit/9b1c30f12a37f7aa6248795d6b3f96b939bebaf9))
* **hub:** list every unexpired API key, past the first 100 rows ([#203](https://github.com/elflodge/elflodge/issues/203)) ([30aa541](https://github.com/elflodge/elflodge/commit/30aa541fecccb089efa7d6372387bc7784600454))
* **hub:** refuse a removed member's session ([#175](https://github.com/elflodge/elflodge/issues/175)) ([0d3ff26](https://github.com/elflodge/elflodge/commit/0d3ff2623b41d33569f5adf0a86e9ebc2064407f))
* **hub:** serve the API reference without sending anything to third parties ([#193](https://github.com/elflodge/elflodge/issues/193)) ([86f0277](https://github.com/elflodge/elflodge/commit/86f0277ff0d00e3d3880d09bc478df3c842a96f4))
* make CLI help and the API reference true on both surfaces ([#190](https://github.com/elflodge/elflodge/issues/190)) ([3b807ec](https://github.com/elflodge/elflodge/commit/3b807ec18d8dd06caf1b1028a8e1949409fb811d))
* **pi-durable-extension-adapter:** take TypeBox at the version Pi pins ([#167](https://github.com/elflodge/elflodge/issues/167)) ([12828cf](https://github.com/elflodge/elflodge/commit/12828cfb37f1d3ee380870a2a922878925f36547))
* preserve job output and align the Vite+ toolchain ([#250](https://github.com/elflodge/elflodge/issues/250)) ([1529218](https://github.com/elflodge/elflodge/commit/152921855b58794f6e040801d47cf7028debd748))
* refuse a signed-in non-member with 403, not 401 ([#176](https://github.com/elflodge/elflodge/issues/176)) ([ea49cca](https://github.com/elflodge/elflodge/commit/ea49ccac21f7a6a37c3de72262573f18e847b544))
* refuse bracketed status filters instead of ignoring them ([#188](https://github.com/elflodge/elflodge/issues/188)) ([76ea961](https://github.com/elflodge/elflodge/commit/76ea9610c105cb762f6ec359cde189674915154b))
* refuse unknown query parameters on the reads without input ([#199](https://github.com/elflodge/elflodge/issues/199)) ([e826320](https://github.com/elflodge/elflodge/commit/e8263204ec18736dd6d5e0404f4dd0b79963f79a))
* **runner:** refuse IP destinations at the host's addresses as they are now ([#156](https://github.com/elflodge/elflodge/issues/156)) ([dac9deb](https://github.com/elflodge/elflodge/commit/dac9debd1221709bccbca51bdaf687fa0a5513f3))


### Performance Improvements

* **hub:** lay a Batch's labels beneath each job's own in Postgres, not in the hub ([#234](https://github.com/elflodge/elflodge/issues/234)) ([d718089](https://github.com/elflodge/elflodge/commit/d7180899fe207316c74ceb9b6b746ab12bab815b))

## [0.10.0](https://github.com/elflodge/elflodge/compare/v0.9.0...v0.10.0) (2026-11-13)


### Features

* package Agent Batches as a Claude plugin ([#118](https://github.com/elflodge/elflodge/issues/118)) ([d1b79d2](https://github.com/elflodge/elflodge/commit/d1b79d292419c0f9faed53be123e7c73b555cf77))
* **runner:** job commands reach the internet, with local and private addresses refused ([#147](https://github.com/elflodge/elflodge/issues/147)) ([5ea0ef7](https://github.com/elflodge/elflodge/commit/5ea0ef7a79839aff8fe73dd6b405660e92820eb4))
* runners report their capabilities to the hub ([#143](https://github.com/elflodge/elflodge/issues/143)) ([f0e5c43](https://github.com/elflodge/elflodge/commit/f0e5c43f9b4c1cd6532a6e12360082bb15f0786c))


### Bug Fixes

* **deps:** update Pi to 1.5.2, whose Anthropic sign-in reports a current Claude Code version ([#141](https://github.com/elflodge/elflodge/issues/141)) ([443179d](https://github.com/elflodge/elflodge/commit/443179d495e6802b5406742406d5dc51f5cda84c))
* **runner:** a job whose journal is lost fails as journalLost instead of starting over ([#145](https://github.com/elflodge/elflodge/issues/145)) ([98e97aa](https://github.com/elflodge/elflodge/commit/98e97aa8ded64631a8ccaa1bd97d7149df93e192))
* **runner:** let macOS jobs start Node and sh, and test the sandbox on macOS in CI ([#146](https://github.com/elflodge/elflodge/issues/146)) ([2fcb6d0](https://github.com/elflodge/elflodge/commit/2fcb6d025584011ce450c5f8cb4d47559673b564))

## [0.9.0](https://github.com/elflodge/elflodge/compare/v0.8.0...v0.9.0) (2026-11-11)


### Features

* **cli:** elflodge stack start --search sets the providers jobs may search through, and --reset-search returns to the Runner's default ([81d3965](https://github.com/elflodge/elflodge/commit/81d3965f8ee9ea312236ae1c771f26d183b57f7a))
* **pi-durable-extension-adapter:** attach takes onLost, called for each conversation whose extensions are lost when their worker exits ([81d3965](https://github.com/elflodge/elflodge/commit/81d3965f8ee9ea312236ae1c771f26d183b57f7a))
* **runner:** run Pi extensions in jobs, from an npm project folder named in RUNNER_EXTENSIONS_DIR, with their settings files from RUNNER_EXTENSION_SETTINGS_DIR and web search through the providers RUNNER_WEB_SEARCH names; the image's has pi-web-access, which reads web pages and PDFs, with web search off otherwise, except through a ChatGPT subscription the jobs' model runs on ([81d3965](https://github.com/elflodge/elflodge/commit/81d3965f8ee9ea312236ae1c771f26d183b57f7a))


### Bug Fixes

* **pi-durable-extension-adapter:** prepareExtensions resolves local sources from the working directory, with Pi's own path helpers, instead of from Pi's install directory, and reports a source with no extension as a failure instead of skipping it ([81d3965](https://github.com/elflodge/elflodge/commit/81d3965f8ee9ea312236ae1c771f26d183b57f7a))

## [0.8.0](https://github.com/elflodge/elflodge/compare/v0.7.1...v0.8.0) (2026-11-10)


### Features

* **cli:** package batch automation skill for Pi ([#116](https://github.com/elflodge/elflodge/issues/116)) ([0cdc2b9](https://github.com/elflodge/elflodge/commit/0cdc2b9f77a901463e52d4ac98ca1d573abcec0a))
* **pi-durable-extension-adapter:** report tool progress and context usage to extensions ([#130](https://github.com/elflodge/elflodge/issues/130)) ([541d947](https://github.com/elflodge/elflodge/commit/541d947a34ee5e05bb7c58d0253aba704377542b))
* **pi-durable-extension-adapter:** run Pi extensions on pi-durable ([#115](https://github.com/elflodge/elflodge/issues/115)) ([3dc50e6](https://github.com/elflodge/elflodge/commit/3dc50e6eff30c166c32df187c58fbfefd5c75d56))
* **runner:** warm prompt caches before starting peer jobs ([#111](https://github.com/elflodge/elflodge/issues/111)) ([65d162e](https://github.com/elflodge/elflodge/commit/65d162e6634126a78cdbc38ba68a820ef0f71dac))


### Bug Fixes

* **pi-durable-extension-adapter:** end an answered run before closing its extensions ([#129](https://github.com/elflodge/elflodge/issues/129)) ([19c022f](https://github.com/elflodge/elflodge/commit/19c022f7f18ca32544b97e635765214aef7c43e5))
* **pi-durable-extension-adapter:** give each conversation its own extension ([#126](https://github.com/elflodge/elflodge/issues/126)) ([ce8f38b](https://github.com/elflodge/elflodge/commit/ce8f38bddd865cf00c3f87abc48233ae38dc9e05))
* **pi-durable-extension-adapter:** offer tools registered after setActiveTools ([#124](https://github.com/elflodge/elflodge/issues/124)) ([0df42b3](https://github.com/elflodge/elflodge/commit/0df42b3ccf6f8a0c9ffb0c0ffe8a19a604f9b75e))

## [0.7.1](https://github.com/elflodge/elflodge/compare/v0.7.0...v0.7.1) (2026-11-08)


### Bug Fixes

* **cli:** skip lines holding only whitespace in a batches submit JSONL file ([#109](https://github.com/elflodge/elflodge/issues/109)) ([33c1439](https://github.com/elflodge/elflodge/commit/33c143965f820c20023fd1ea45e74d5342887fd9))
* **hub:** the Node.js hub answers a request whose path holds a raw backslash with 400, so a reverse proxy's path-based rules cannot be bypassed (GHSA-jpvv-r467-5p4w) ([5d35f35](https://github.com/elflodge/elflodge/commit/5d35f354cc0b58340f876d43ce1aa2c7c3e0d5c3))
* **runner:** a job whose agent was cut off by Runner restarts more times than the restart limit fails at once as `runFaulted`, instead of waiting out its timeout ([d3054b9](https://github.com/elflodge/elflodge/commit/d3054b9ebd63c43991b9762369a62fd134bd5918))
* **runner:** a job's cost, its budget and the CLI's cost figure are what OpenRouter bills, instead of an estimate from the model's list price; other providers still give the estimate ([d3054b9](https://github.com/elflodge/elflodge/commit/d3054b9ebd63c43991b9762369a62fd134bd5918))
* **runner:** a model call cut off by a crash counts as a failed attempt and is retried after the retry backoff, instead of being resent at once ([d3054b9](https://github.com/elflodge/elflodge/commit/d3054b9ebd63c43991b9762369a62fd134bd5918))

## [0.7.0](https://github.com/elflodge/elflodge/compare/v0.6.0...v0.7.0) (2026-11-01)


### ⚠ BREAKING CHANGES

* rename agent-batch to Elflodge ([#76](https://github.com/elflodge/elflodge/issues/76))

### Features

* rename agent-batch to Elflodge ([#76](https://github.com/elflodge/elflodge/issues/76)) ([5e1d61d](https://github.com/elflodge/elflodge/commit/5e1d61d7bd7e2aea980f914a2970e834a6c1afb3))


### Bug Fixes

* **deps:** move to @orpc/effect and the renamed error body options ([#77](https://github.com/elflodge/elflodge/issues/77)) ([c6dae83](https://github.com/elflodge/elflodge/commit/c6dae83c4a0663341c69977a04e4161282d0fef4))
* **hub:** answer failures outside oRPC, such as a hub missing its settings, as Problem Details instead of 500 text/plain ([2dcab2a](https://github.com/elflodge/elflodge/commit/2dcab2a4a704b28363f388df2f8c9d4f8fbedfaa))
* **hub:** give error codes oRPC does not know its default status in Problem Details ([2dcab2a](https://github.com/elflodge/elflodge/commit/2dcab2a4a704b28363f388df2f8c9d4f8fbedfaa))

## [0.6.0](https://github.com/chuse-ai/agent-batch/compare/v0.5.0...v0.6.0) (2026-10-31)


### ⚠ BREAKING CHANGES

* a Batch's customId is replaced by its id, which the creation may set.
* **api:** refuse parameters the API does not define ([#58](https://github.com/chuse-ai/agent-batch/issues/58))
* inline Input file content is removed, a Batch's agent takes no files, and the Runner listing names a file's hash `digest`.
* A job's `result` is now `output`, a Batch agent's `resultContract` is `outputContract`, the failure reason `noResult` is `noOutput`, and the agent's tool is `submit_output`. The Runner protocol changes within agent-batch.v1, so Runners and hubs must be upgraded together. The hub refuses a database created by an earlier release: recreate it, and clear each Runner's RUNNER_DATA_DIR.

### Features

* a Batch has one id, which its caller may set ([#62](https://github.com/chuse-ai/agent-batch/issues/62)) ([e1605b1](https://github.com/chuse-ai/agent-batch/commit/e1605b1bc54dec55c17ba1db2f64182f6a096350))
* **api:** refuse parameters the API does not define ([#58](https://github.com/chuse-ai/agent-batch/issues/58)) ([e87bd47](https://github.com/chuse-ai/agent-batch/commit/e87bd4720d5e4238e241df9f24b4c48354f93a24))
* **cli:** batches submit runs a Batch from a JSONL file or with --each files and folders ([#57](https://github.com/chuse-ai/agent-batch/issues/57)) ([1349463](https://github.com/chuse-ai/agent-batch/commit/1349463fe83e2c584cf57997c65b57c65f7c3b11))
* **cli:** the wait's progress counts running jobs as agents running ([#63](https://github.com/chuse-ai/agent-batch/issues/63)) ([de33488](https://github.com/chuse-ai/agent-batch/commit/de334886037900e0e9e0cba798739adde49e0504))
* name the job's value its output ([#50](https://github.com/chuse-ai/agent-batch/issues/50)) ([8a05327](https://github.com/chuse-ai/agent-batch/commit/8a053270a32cb0518a7a95f7c5d3e55ecfc312f4))
* **runner:** read PDFs with poppler's pdftotext and pdftoppm ([#54](https://github.com/chuse-ai/agent-batch/issues/54)) ([185630a](https://github.com/chuse-ai/agent-batch/commit/185630ad5265656efb4ed3d3b47ad038dbd03fc6))
* upload Input files before the jobs that name them ([#56](https://github.com/chuse-ai/agent-batch/issues/56)) ([da57159](https://github.com/chuse-ai/agent-batch/commit/da57159c2e1a41f269f558ba53af358230e4968a))

## [0.5.0](https://github.com/chuse-ai/agent-batch/compare/v0.4.0...v0.5.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* Supported Docker deployments require Engine 29 or later and Compose 5 or later.

### Features

* **cli:** agent-batch stack runs the local deployment in the background ([#46](https://github.com/chuse-ai/agent-batch/issues/46)) ([f3ce73d](https://github.com/chuse-ai/agent-batch/commit/f3ce73db326aafaff125c3ebdcab0b2700b4b603))
* **cli:** guide stack startup and manage provider credentials ([#48](https://github.com/chuse-ai/agent-batch/issues/48)) ([ed17876](https://github.com/chuse-ai/agent-batch/commit/ed1787618af8b4504a9a99fe149aab4930b44dc1))


### Build System

* update Vite+ and the supported Docker baseline ([#47](https://github.com/chuse-ai/agent-batch/issues/47)) ([7003340](https://github.com/chuse-ai/agent-batch/commit/70033408993500ecae818f33d3d8eae86f1e85e9))

## [0.4.0](https://github.com/chuse-ai/agent-batch/compare/v0.3.0...v0.4.0) (2026-10-27)


### ⚠ BREAKING CHANGES

* `POST /jobs` is replaced by `POST /batches` and `POST /batches/{id}/jobs`; `prompt` is now `input`, and a job's Result contract and limits come from its Batch's agent. The Runner protocol's job content carries `instructions` and `input` in place of `prompt`, so Runners and hubs must be upgraded together.

### Features

* run every job in a Batch that shares its agent, Canary and breaker; label and list jobs ([#33](https://github.com/chuse-ai/agent-batch/issues/33)) ([108b54f](https://github.com/chuse-ai/agent-batch/commit/108b54fb82d038a08b1d5094b7a34702330b9c1b))
* **runner:** call the model provider at RUNNER_MODEL_BASE_URL ([#32](https://github.com/chuse-ai/agent-batch/issues/32)) ([72e83f0](https://github.com/chuse-ai/agent-batch/commit/72e83f0ca929b3925c340795443e997375291a1f))


### Bug Fixes

* **contract:** leave the Runner's own calls out of the public API ([#31](https://github.com/chuse-ai/agent-batch/issues/31)) ([af8714f](https://github.com/chuse-ai/agent-batch/commit/af8714f4f690c205936fb4ca26acd88a2a4a56dd))
* **deps:** upgrade pi to 1.4.0, whose journals older Runners cannot open ([#39](https://github.com/chuse-ai/agent-batch/issues/39)) ([4218547](https://github.com/chuse-ai/agent-batch/commit/42185475da7da3632773229d3bddbff921ff05c4))
* run the quickstart from the latest release's Compose file and images ([#30](https://github.com/chuse-ai/agent-batch/issues/30)) ([70cf1a4](https://github.com/chuse-ai/agent-batch/commit/70cf1a49b9eb0dfbab84726b5c78a6d5c0029753))


### Performance Improvements

* **runner:** give sandbox-runtime the shell's path, not its name ([#38](https://github.com/chuse-ai/agent-batch/issues/38)) ([823db6d](https://github.com/chuse-ai/agent-batch/commit/823db6d38da50b497573aca17aa937da970ac101))

## [0.3.0](https://github.com/chuse-ai/agent-batch/compare/v0.2.0...v0.3.0) (2026-10-26)


### ⚠ BREAKING CHANGES

* send Input files apart from the sync ([#21](https://github.com/chuse-ai/agent-batch/issues/21))
* give a failed job its failure, with the cause's message ([#19](https://github.com/chuse-ai/agent-batch/issues/19))

### Features

* give a failed job its failure, with the cause's message ([#19](https://github.com/chuse-ai/agent-batch/issues/19)) ([02f2d1c](https://github.com/chuse-ai/agent-batch/commit/02f2d1cac187bfa19a3eff89a27e4675c6197966))
* **runner:** sign in to the model provider's subscription ([#17](https://github.com/chuse-ai/agent-batch/issues/17)) ([3c33013](https://github.com/chuse-ai/agent-batch/commit/3c330131545dffe5b4f1a32e6a1a1ddc37c3cdd4))


### Bug Fixes

* **contract:** refuse results nested too deeply ([#15](https://github.com/chuse-ai/agent-batch/issues/15)) ([11589a2](https://github.com/chuse-ai/agent-batch/commit/11589a2f2977ba81f66a971b78b6b6c7f9850a8c))
* **runner:** end a job whose tool call never ends ([#20](https://github.com/chuse-ai/agent-batch/issues/20)) ([76753d4](https://github.com/chuse-ai/agent-batch/commit/76753d4684989629a26f3bace6b1d84066bd18cc))
* **runner:** kill a job's process, not the Runner, when the host runs out of memory ([#22](https://github.com/chuse-ai/agent-batch/issues/22)) ([537949b](https://github.com/chuse-ai/agent-batch/commit/537949b2a9876f3d2d6e44aa079d67e8325b8de5))
* send Input files apart from the sync ([#21](https://github.com/chuse-ai/agent-batch/issues/21)) ([e51de33](https://github.com/chuse-ai/agent-batch/commit/e51de33c612d081f85493a5d0a55075c8009d917))
