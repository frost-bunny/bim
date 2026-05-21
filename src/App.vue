<template>
  <component :is="TwinViewerPage"/>
</template>

<script setup lang="ts">
import TwinViewerPage from './pages/TwinViewerPage.vue';
import GisPage from './pages/GisPage.vue';
</script>
